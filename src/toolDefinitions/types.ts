export type ToolKey =
  | 'compress'
  | 'merge'
  | 'split'
  | 'pdf-to-jpg'
  | 'jpg-to-pdf'
  | 'organize-pdf'
  | 'rotate-pdf'
  | 'page-numbers'
  | 'pdf-to-word'
  | 'image-reduce'
  | 'image-resize'
  | 'image-crop'
  | 'image-rotate'
  | 'image-signature'
  | 'image-dob'
  | 'image-border'
  | 'code-diff'
  | 'count-text'

export type ToolCategory = 'pdf' | 'image' | 'code' | 'text'

export type ToolInfo = {
  id: ToolKey
  label: string
  description: string
  tagline: string
  category: ToolCategory
}
