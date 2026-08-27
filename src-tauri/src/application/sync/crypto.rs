//! Passphrase-derived encryption for sync payloads: Argon2id turns a
//! passphrase into a symmetric key, XChaCha20-Poly1305 seals/opens bytes
//! under that key. No crate here reads or writes files — callers own I/O.

use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use thiserror::Error;

pub const SALT_LEN: usize = 16;
pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;

/// Fixed plaintext sealed with a newly-set key so a later machine can
/// verify a passphrase without ever decrypting real sync data.
const KEYCHECK_SENTINEL: &[u8] = b"openray-sync-keycheck-v1";

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("failed to generate random bytes")]
    Random,
    #[error("key derivation failed")]
    Kdf,
    #[error("encryption failed")]
    Seal,
    #[error("decryption failed (wrong passphrase or corrupted data)")]
    Open,
    #[error("sealed payload is too short to contain a nonce")]
    Truncated,
}

pub type Key32 = [u8; KEY_LEN];

pub fn generate_salt() -> Result<[u8; SALT_LEN], CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    getrandom::fill(&mut salt).map_err(|_| CryptoError::Random)?;
    Ok(salt)
}

/// Derives a 32-byte symmetric key from a passphrase and salt via Argon2id.
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Key32, CryptoError> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| CryptoError::Kdf)?;
    Ok(key)
}

/// Encrypts `plaintext` under `key`, returning `nonce || ciphertext`.
pub fn seal(key: &Key32, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|_| CryptoError::Random)?;

    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|_| CryptoError::Seal)?;

    let mut sealed = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    sealed.extend_from_slice(&nonce_bytes);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Decrypts a payload produced by [`seal`]. Returns [`CryptoError::Open`]
/// for both a wrong key and tampered/corrupted bytes — AEAD does not
/// distinguish the two.
pub fn open(key: &Key32, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < NONCE_LEN {
        return Err(CryptoError::Truncated);
    }
    let (nonce_bytes, ciphertext) = sealed.split_at(NONCE_LEN);

    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XNonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|_| CryptoError::Open)
}

/// Seals the keycheck sentinel under `key`, for storage in `meta.json` so a
/// later machine can verify a passphrase before trusting it against real data.
pub fn seal_keycheck(key: &Key32) -> Result<Vec<u8>, CryptoError> {
    seal(key, KEYCHECK_SENTINEL)
}

/// Verifies `key` against a keycheck payload previously produced by
/// [`seal_keycheck`]. Returns `false` (not an error) for a wrong passphrase.
pub fn verify_keycheck(key: &Key32, keycheck: &[u8]) -> bool {
    matches!(open(key, keycheck), Ok(plaintext) if plaintext == KEYCHECK_SENTINEL)
}

/// Lowercase hex encoding — used for `meta.json`'s `kdf_salt`/`keycheck`
/// fields, which need to be plain JSON strings. No `hex` crate dependency:
/// this is the same per-byte `{b:02x}` approach `placeholders::pseudo_uuid`
/// already uses elsewhere in this codebase.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let salt = generate_salt().unwrap();
        let key = derive_key("correct horse battery staple", &salt).unwrap();
        let sealed = seal(&key, b"hello sync").unwrap();
        let opened = open(&key, &sealed).unwrap();
        assert_eq!(opened, b"hello sync");
    }

    #[test]
    fn wrong_key_fails_to_open() {
        let salt = generate_salt().unwrap();
        let key = derive_key("correct passphrase", &salt).unwrap();
        let wrong_key = derive_key("wrong passphrase", &salt).unwrap();
        let sealed = seal(&key, b"secret payload").unwrap();
        assert!(matches!(open(&wrong_key, &sealed), Err(CryptoError::Open)));
    }

    #[test]
    fn tampered_ciphertext_fails_to_open() {
        let salt = generate_salt().unwrap();
        let key = derive_key("a passphrase", &salt).unwrap();
        let mut sealed = seal(&key, b"integrity matters").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xFF;
        assert!(open(&key, &sealed).is_err());
    }

    #[test]
    fn truncated_payload_is_rejected() {
        let key = [0u8; KEY_LEN];
        assert!(matches!(open(&key, &[1, 2, 3]), Err(CryptoError::Truncated)));
    }

    #[test]
    fn keycheck_roundtrip() {
        let salt = generate_salt().unwrap();
        let key = derive_key("device passphrase", &salt).unwrap();
        let keycheck = seal_keycheck(&key).unwrap();
        assert!(verify_keycheck(&key, &keycheck));

        let wrong_key = derive_key("not the passphrase", &salt).unwrap();
        assert!(!verify_keycheck(&wrong_key, &keycheck));
    }

    #[test]
    fn hex_round_trips_arbitrary_bytes() {
        let bytes = [0u8, 1, 255, 16, 128, 7];
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
    }

    #[test]
    fn from_hex_rejects_odd_length_and_non_hex_input() {
        assert!(from_hex("abc").is_none());
        assert!(from_hex("zz").is_none());
    }

    #[test]
    fn nonces_differ_between_seals() {
        let salt = generate_salt().unwrap();
        let key = derive_key("p", &salt).unwrap();
        let a = seal(&key, b"same plaintext").unwrap();
        let b = seal(&key, b"same plaintext").unwrap();
        assert_ne!(a, b, "random nonce must make repeated seals differ");
    }
}
