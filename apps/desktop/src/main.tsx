import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { SettingsWindow } from './features/settings/SettingsWindow.tsx'
import { ExtensionWindow } from './features/extension-window/ExtensionWindow.tsx'

const isSettingsWindow = window.location.hash.startsWith('#/settings')
const isExtensionWindow = window.location.hash.startsWith('#/extension-window/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isSettingsWindow ? <SettingsWindow /> : isExtensionWindow ? <ExtensionWindow /> : <App />}</StrictMode>,
)
