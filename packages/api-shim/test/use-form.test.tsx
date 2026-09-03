import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetNodeIdsForTests, mount } from '../src/reconciler'
import { Form } from '../src/components/Form'
import { useForm, FormValidation } from '../src/utils-hooks'
import { flush } from './flush'

/**
 * `useForm` was a stub, so `const { handleSubmit, itemProps } = useForm(…)`
 * destructured cleanly, the form rendered, and submitting did nothing at
 * all — a silent no-op with no error anywhere. 29 of 180 sampled
 * extensions use it.
 */

beforeEach(() => {
  _resetNodeIdsForTests()
})

/** Renders a component and hands back the hook's own result object. */
async function renderHook<T>(use: () => T): Promise<{ current: T }> {
  const box = { current: undefined as unknown as T }
  function Probe() {
    box.current = use()
    return createElement(Form, null)
  }
  mount(createElement(Probe), () => {})
  await flush()
  return box
}

describe('useForm', () => {
  it('submits when every validation passes', async () => {
    const onSubmit = vi.fn()
    const form = await renderHook(() =>
      useForm<{ name: string }>({ onSubmit, validation: { name: FormValidation.Required } }),
    )

    await form.current.handleSubmit({ name: 'Ada' })

    expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' })
  })

  it('blocks submit and sets an error when a required field is empty', async () => {
    const onSubmit = vi.fn()
    const form = await renderHook(() =>
      useForm<{ name: string }>({ onSubmit, validation: { name: FormValidation.Required } }),
    )

    const result = await form.current.handleSubmit({ name: '' })
    await flush()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(result).toBe(false)
    expect(form.current.itemProps.name!.error).toBeTruthy()
  })

  it('treats whitespace and an empty array as empty', async () => {
    const onSubmit = vi.fn()
    const form = await renderHook(() =>
      useForm<{ name: string; files: string[] }>({
        onSubmit,
        validation: { name: FormValidation.Required, files: FormValidation.Required },
      }),
    )

    await form.current.handleSubmit({ name: '   ', files: [] })
    await flush()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(form.current.itemProps.name!.error).toBeTruthy()
    expect(form.current.itemProps.files!.error).toBeTruthy()
  })

  it('supports a custom validator function', async () => {
    const onSubmit = vi.fn()
    const form = await renderHook(() =>
      useForm<{ age: string }>({
        onSubmit,
        validation: { age: (value) => (Number(value) > 17 ? undefined : 'Too young') },
      }),
    )

    await form.current.handleSubmit({ age: '12' })
    await flush()
    expect(form.current.itemProps.age!.error).toBe('Too young')
  })

  it('focuses the first invalid field on a failed submit', async () => {
    // Without this the error can sit scrolled out of sight in a long form.
    const form = await renderHook(() =>
      useForm<{ first: string; second: string }>({
        onSubmit: vi.fn(),
        validation: { first: FormValidation.Required, second: FormValidation.Required },
      }),
    )

    await form.current.handleSubmit({ first: '', second: '' })
    await flush()

    expect(form.current.itemProps.first!.focusRequest).toBeTypeOf('number')
    expect(form.current.itemProps.second!.focusRequest).toBeUndefined()
  })

  it('re-fires a focus request for the same field twice', async () => {
    // A boolean would only ever transition once, so the second focus()
    // call would be silently ignored.
    const form = await renderHook(() => useForm<{ name: string }>({ onSubmit: vi.fn() }))

    form.current.focus('name')
    await flush()
    const first = form.current.itemProps.name!.focusRequest

    form.current.focus('name')
    await flush()

    expect(form.current.itemProps.name!.focusRequest).not.toBe(first)
  })

  it('clears a field error as soon as the field changes', async () => {
    const form = await renderHook(() =>
      useForm<{ name: string }>({ onSubmit: vi.fn(), validation: { name: FormValidation.Required } }),
    )

    await form.current.handleSubmit({ name: '' })
    await flush()
    expect(form.current.itemProps.name!.error).toBeTruthy()

    ;(form.current.itemProps.name!.onChange as (v: unknown) => void)('typed')
    await flush()

    expect(form.current.itemProps.name!.error).toBeUndefined()
  })

  it('exposes initialValues as each field defaultValue', async () => {
    const form = await renderHook(() =>
      useForm<{ name: string }>({ onSubmit: vi.fn(), initialValues: { name: 'Ada' } }),
    )

    expect(form.current.itemProps.name!.defaultValue).toBe('Ada')
  })
})
