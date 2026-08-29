import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'
import { withFallbacks } from './namespace-fallback'

interface BaseFieldProps<Value> {
  id: string
  title?: string
  info?: string
  error?: string
  autoFocus?: boolean
  storeValue?: boolean
  defaultValue?: Value
  value?: Value
  onChange?: (value: Value) => void
  onBlur?: () => void
  onFocus?: () => void
}

export interface FormTextFieldProps extends BaseFieldProps<string> {
  placeholder?: string
}
function FormTextField(props: FormTextFieldProps): ReactElement {
  return createElement(NodeType.FormTextField, props)
}

export interface FormPasswordFieldProps extends BaseFieldProps<string> {
  placeholder?: string
}
function FormPasswordField(props: FormPasswordFieldProps): ReactElement {
  return createElement(NodeType.FormPasswordField, props)
}

export interface FormTextAreaProps extends BaseFieldProps<string> {
  placeholder?: string
  enableMarkdown?: boolean
}
function FormTextArea(props: FormTextAreaProps): ReactElement {
  return createElement(NodeType.FormTextArea, props)
}

export interface FormCheckboxProps extends BaseFieldProps<boolean> {
  label: string
}
function FormCheckbox(props: FormCheckboxProps): ReactElement {
  return createElement(NodeType.FormCheckbox, props)
}

export interface FormDropdownItemProps {
  title: string
  value: string
  icon?: string
}
function FormDropdownItem(props: FormDropdownItemProps): ReactElement {
  return createElement(NodeType.FormDropdownItem, props)
}

export interface FormDropdownProps extends BaseFieldProps<string> {
  placeholder?: string
  children?: ReactNode
}
function FormDropdown(props: FormDropdownProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.FormDropdown, rest, children)
}
FormDropdown.Item = FormDropdownItem

export interface FormDescriptionProps {
  title?: string
  text: string
}
function FormDescription(props: FormDescriptionProps): ReactElement {
  return createElement(NodeType.FormDescription, props)
}

function FormSeparator(): ReactElement {
  return createElement(NodeType.FormSeparator, {})
}

export interface FormProps {
  navigationTitle?: string
  isLoading?: boolean
  actions?: ReactNode
  children?: ReactNode
}

function FormBase(props: FormProps): ReactElement {
  const { children, actions, ...rest } = props
  return createElement(NodeType.Form, rest, actionsSlot(actions), children)
}
FormBase.TextField = FormTextField
FormBase.PasswordField = FormPasswordField
FormBase.TextArea = FormTextArea
FormBase.Checkbox = FormCheckbox
FormBase.Dropdown = FormDropdown
export interface FormFilePickerProps {
  id: string
  title?: string
  info?: string
  error?: string
  /** Raycast's value type here is an array of paths, even for a single
   *  selection — matched exactly so an extension's own indexing
   *  (`values.folder[0]`) works unchanged. */
  value?: string[]
  defaultValue?: string[]
  canChooseFiles?: boolean
  canChooseDirectories?: boolean
  showHiddenFiles?: boolean
  allowMultipleSelection?: boolean
  onChange?: (value: string[]) => void
}
function FormFilePicker(props: FormFilePickerProps): ReactElement {
  return createElement(NodeType.FormFilePicker, {
    canChooseFiles: true,
    canChooseDirectories: false,
    allowMultipleSelection: true,
    ...props,
  })
}

export interface FormDatePickerProps {
  id: string
  title?: string
  info?: string
  error?: string
  /** Raycast's own enum: date only, or date and time. */
  type?: 'Date' | 'DateTime'
  value?: Date | null
  defaultValue?: Date | null
  min?: Date
  max?: Date
  onChange?: (value: Date | null) => void
}
/**
 * Raycast hands the extension a `Date`, but a prop crossing to the
 * renderer has to be JSON — so it travels as an ISO string and is turned
 * back into a `Date` here on the way out. An extension doing
 * `values.when.getTime()` would otherwise get a string and throw.
 */
function FormDatePicker(props: FormDatePickerProps): ReactElement {
  const { value, defaultValue, min, max, onChange, ...rest } = props
  return createElement(NodeType.FormDatePicker, {
    ...rest,
    type: props.type ?? 'DateTime',
    ...(value !== undefined ? { value: value ? value.toISOString() : null } : {}),
    ...(defaultValue !== undefined ? { defaultValue: defaultValue ? defaultValue.toISOString() : null } : {}),
    ...(min ? { min: min.toISOString() } : {}),
    ...(max ? { max: max.toISOString() } : {}),
    ...(onChange ? { onChange: (raw: unknown) => onChange(typeof raw === 'string' && raw ? new Date(raw) : null) } : {}),
  })
}

export interface FormTagPickerItemProps {
  value: string
  title?: string
  icon?: unknown
}
function FormTagPickerItem(props: FormTagPickerItemProps): ReactElement {
  return createElement(NodeType.FormTagPickerItem, props)
}

export interface FormTagPickerProps {
  id: string
  title?: string
  info?: string
  error?: string
  placeholder?: string
  value?: string[]
  defaultValue?: string[]
  onChange?: (value: string[]) => void
  children?: ReactNode
}
function FormTagPicker(props: FormTagPickerProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.FormTagPicker, rest, children)
}
FormTagPicker.Item = FormTagPickerItem

export interface FormDropdownSectionProps {
  title?: string
  children?: ReactNode
}
function FormDropdownSection(props: FormDropdownSectionProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.FormDropdownSection, rest, children)
}

FormDropdown.Section = FormDropdownSection
FormBase.DatePicker = FormDatePicker
FormBase.TagPicker = FormTagPicker
FormBase.FilePicker = FormFilePicker
FormBase.Description = FormDescription
FormBase.Separator = FormSeparator

/**
 * A `Form.*` member this shim doesn't implement.
 *
 * Rendered as an inert note inside the form rather than dropped, so the
 * gap is visible where it happens instead of the field silently missing —
 * and, crucially, so the command still mounts. `Form.FilePicker` alone
 * accounted for 14 dead extensions in a 180-extension sample.
 */
const formWithFallbacks = withFallbacks(FormBase, (name) => {
  return (props: { id?: string; title?: string }): ReactElement =>
    createElement(NodeType.FormUnsupported, { ...props, name })
})

/** The `Form` extensions actually see. */
export const Form = formWithFallbacks
