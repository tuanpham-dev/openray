import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'

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

export function Form(props: FormProps): ReactElement {
  const { children, actions, ...rest } = props
  return createElement(NodeType.Form, rest, actionsSlot(actions), children)
}
Form.TextField = FormTextField
Form.PasswordField = FormPasswordField
Form.TextArea = FormTextArea
Form.Checkbox = FormCheckbox
Form.Dropdown = FormDropdown
Form.Description = FormDescription
Form.Separator = FormSeparator
