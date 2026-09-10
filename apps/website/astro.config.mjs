// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// The landing page owns `/` as a plain Astro page; Starlight is mounted under
// `/docs/` so the product page can have a free layout instead of Starlight's
// splash template. `base` matches the GitHub Pages project path.
export default defineConfig({
  site: 'https://tuanpham-dev.github.io',
  base: '/openray',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'OpenRay',
      description: 'An open-source, cross-platform command palette and launcher.',
      logo: { src: './src/assets/logo.svg', alt: 'OpenRay' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tuanpham-dev/openray' }],
      editLink: { baseUrl: 'https://github.com/tuanpham-dev/openray/edit/main/apps/website/' },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Install', slug: 'docs/getting-started/install' },
            { label: 'First run', slug: 'docs/getting-started/first-run' },
            { label: 'Core concepts', slug: 'docs/getting-started/core-concepts' },
            { label: 'Keyboard shortcuts', slug: 'docs/getting-started/keyboard-shortcuts' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'Application search', slug: 'docs/features/applications' },
            { label: 'Calculator', slug: 'docs/features/calculator' },
            { label: 'Clipboard History', slug: 'docs/features/clipboard-history' },
            { label: 'Snippets', slug: 'docs/features/snippets' },
            { label: 'Quicklinks', slug: 'docs/features/quicklinks' },
            { label: 'Window Management', slug: 'docs/features/window-management' },
            { label: 'Switch Windows', slug: 'docs/features/switch-windows' },
            { label: 'System Commands', slug: 'docs/features/system-commands' },
            { label: 'Script Commands', slug: 'docs/features/script-commands' },
            { label: 'Emoji & Symbols', slug: 'docs/features/emoji' },
            { label: 'File Search', slug: 'docs/features/file-search' },
            { label: 'Screenshots', slug: 'docs/features/screenshots' },
            { label: 'Notes', slug: 'docs/features/notes' },
            { label: 'Translate', slug: 'docs/features/translate' },
            { label: 'Menu Bar Search', slug: 'docs/features/menu-bar-search' },
            { label: 'AI', slug: 'docs/features/ai' },
          ],
        },
        {
          label: 'Extensions',
          items: [
            { label: 'The Store', slug: 'docs/extensions/store' },
            { label: 'Installing extensions', slug: 'docs/extensions/installing' },
            { label: 'Trust and security', slug: 'docs/extensions/trust-and-security' },
          ],
        },
        {
          label: 'Settings',
          items: [
            { label: 'General', slug: 'docs/settings/general' },
            { label: 'Extensions and commands', slug: 'docs/settings/extensions-and-commands' },
            { label: 'Import / Export', slug: 'docs/settings/import-export' },
            { label: 'Advanced', slug: 'docs/settings/advanced' },
          ],
        },
        {
          label: 'Platform notes',
          items: [
            { label: 'macOS', slug: 'docs/platforms/macos' },
            { label: 'Windows', slug: 'docs/platforms/windows' },
            { label: 'Linux', slug: 'docs/platforms/linux' },
          ],
        },
        {
          label: 'Developers',
          items: [
            { label: 'Architecture', slug: 'docs/developers/architecture' },
            { label: 'Writing an extension', slug: 'docs/developers/writing-extensions' },
            { label: 'CLI reference', slug: 'docs/developers/cli' },
            { label: 'Import / Export hooks', slug: 'docs/developers/import-export-hooks' },
            { label: 'Packaging and registries', slug: 'docs/developers/packaging-and-registries' },
            { label: 'Building from source', slug: 'docs/developers/building-from-source' },
            { label: 'Platform verification', slug: 'docs/developers/platform-verification' },
          ],
        },
        { label: 'FAQ', slug: 'docs/faq' },
      ],
    }),
  ],
})
