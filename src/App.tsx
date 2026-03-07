import type { CSSProperties, ChangeEvent, FormEvent, MouseEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Document as DocxDocument, Packer, Paragraph } from 'docx'
import JSZip from 'jszip'
import { diffWords } from 'diff'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import './App.css'
import { tools, type ToolKey } from './toolDefinitions'

GlobalWorkerOptions.workerSrc = workerSrc

type CompressionPreset = 'low' | 'medium' | 'high'
type CompressionChoice = CompressionPreset | 'custom'

const compressionPresets: Record<
  CompressionChoice,
  { label: string; scale: number; quality: number; detail: string }
> = {
  low: { label: 'Low', scale: 0.95, quality: 0.9, detail: 'Best clarity, light size savings.' },
  medium: { label: 'Medium', scale: 0.86, quality: 0.86, detail: 'Balanced clarity and size.' },
  high: { label: 'High', scale: 0.78, quality: 0.82, detail: 'Stronger shrink with legible pages.' },
  custom: { label: 'Custom', scale: 0.82, quality: 0.86, detail: 'Fine-tune with the slider.' },
}

const getToolPath = (toolId: ToolKey) => `/tools/${toolId}`
const getToolFromPath = (pathname: string): ToolKey => {
  const parts = pathname.split('/').filter(Boolean)
  const fallback: ToolKey = 'compress'

  if (parts.length === 0 || pathname === '/home') return fallback

  const slug = parts[0] === 'tools' ? parts[1] : parts[0]
  if (slug && tools.some((tool) => tool.id === slug)) {
    return slug as ToolKey
  }

  return fallback
}

const formatBytes = (size: number) => {
  if (size === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
  const value = size / Math.pow(1024, exponent)
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

const createOutputName = (name: string, suffix: string, extensionOverride?: string) => {
  const [base, ...rest] = name.split('.')
  const extension = extensionOverride ?? (rest.length ? rest.pop() : 'pdf')
  return `${base}-${suffix}.${extension || 'pdf'}`
}

const downloadBlob = (bytes: Uint8Array | ArrayBuffer, fileName: string) => {
  const source: BlobPart = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)
  const blob = new Blob([source], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

const estimateCompressionSize = (original: number, preset: { scale: number; quality: number }) => {
  const ratio = preset.scale * preset.scale * preset.quality * 0.95
  return Math.max(1024, original * ratio)
}

const estimateImageScale = (original: number, ratio: number, quality = 1) =>
  Math.max(512, original * Math.max(0.05, Math.min(1.2, ratio * quality * 0.95)))

const estimateSimilar = (original: number, multiplier = 1) => Math.max(512, original * multiplier)
const defaultCropValues = { x: 25, y: 25, width: 50, height: 50 }

const downloadFile = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

const parsePageRange = (input: string, totalPages: number) => {
  const sanitized = input.replace(/\s+/g, '')
  if (!sanitized) {
    return Array.from({ length: totalPages }, (_, i) => i)
  }

  const pages = new Set<number>()

  for (const part of sanitized.split(',').filter(Boolean)) {
    if (part.includes('-')) {
      const [startRaw, endRaw] = part.split('-')
      const start = Number(startRaw)
      const end = Number(endRaw)
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error('Use whole numbers in page ranges.')
      }
      const [from, to] = start <= end ? [start, end] : [end, start]
      for (let page = from; page <= to; page += 1) {
        if (page < 1 || page > totalPages) {
          throw new Error(`Page ${page} is outside of 1-${totalPages}.`)
        }
        pages.add(page - 1)
      }
    } else {
      const single = Number(part)
      if (!Number.isInteger(single)) {
        throw new Error('Use whole numbers in page ranges.')
      }
      if (single < 1 || single > totalPages) {
        throw new Error(`Page ${single} is outside of 1-${totalPages}.`)
      }
      pages.add(single - 1)
    }
  }

  return Array.from(pages).sort((a, b) => a - b)
}

const useObjectUrl = (file: File | null) => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url
}

const loadImageFromFile = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Unable to load image.'))
      image.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('Unable to read image file.'))
    reader.readAsDataURL(file)
  })

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Unable to produce image.'))
          return
        }
        resolve(blob)
      },
      type,
      quality,
    )
  })

function App() {
  const [isEmbedded] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('embed') === '1'
  })
  const [activeTool, setActiveTool] = useState<ToolKey>(() => {
    if (typeof window === 'undefined') return 'compress'
    return getToolFromPath(window.location.pathname)
  })
  const [compressionPreset, setCompressionPreset] = useState<CompressionChoice>('medium')
  const [customCompression, setCustomCompression] = useState(0.82)
  const [compressFile, setCompressFile] = useState<File | null>(null)
  const [mergeFiles, setMergeFiles] = useState<File[]>([])
  const [splitFile, setSplitFile] = useState<File | null>(null)
  const [splitPageCount, setSplitPageCount] = useState<number | null>(null)
  const [splitEstimate, setSplitEstimate] = useState<number | null>(null)
  const [splitRange, setSplitRange] = useState('1-2')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadComplete, setUploadComplete] = useState(false)

  const [reduceImageFile, setReduceImageFile] = useState<File | null>(null)
  const [reduceScale, setReduceScale] = useState(0.7)
  const [reduceQuality, setReduceQuality] = useState(0.82)

  const [cropImageFile, setCropImageFile] = useState<File | null>(null)
  const [cropValues, setCropValues] = useState(defaultCropValues)

  const [rotateImageFile, setRotateImageFile] = useState<File | null>(null)
  const [rotateAngle, setRotateAngle] = useState(90)

  const [resizeImageFile, setResizeImageFile] = useState<File | null>(null)
  const [resizeWidth, setResizeWidth] = useState(1200)
  const [resizeHeight, setResizeHeight] = useState(800)

  const [signatureImageFile, setSignatureImageFile] = useState<File | null>(null)
  const [signatureText, setSignatureText] = useState('Signed by...')
  const [signatureSize, setSignatureSize] = useState(18)
  const [signatureColor, setSignatureColor] = useState('#0f172a')

  const [dobImageFile, setDobImageFile] = useState<File | null>(null)
  const [dobText, setDobText] = useState('DOB: 1990-01-01')
  const [dobColor, setDobColor] = useState('#0f172a')

  const [borderImageFile, setBorderImageFile] = useState<File | null>(null)
  const [borderThickness, setBorderThickness] = useState(16)
  const [borderColor, setBorderColor] = useState('#0f172a')

  const [resizeOriginalDims, setResizeOriginalDims] = useState<{ width: number; height: number } | null>(null)
  const [reduceEstimate, setReduceEstimate] = useState<number | null>(null)
  const [resizeEstimate, setResizeEstimate] = useState<number | null>(null)
  const [cropEstimate, setCropEstimate] = useState<number | null>(null)
  const [signatureEstimate, setSignatureEstimate] = useState<number | null>(null)
  const [dobEstimate, setDobEstimate] = useState<number | null>(null)
  const [borderEstimate, setBorderEstimate] = useState<number | null>(null)

  const [pdfToWordFile, setPdfToWordFile] = useState<File | null>(null)
  const [pdfToJpgFile, setPdfToJpgFile] = useState<File | null>(null)
  const [jpgToPdfFiles, setJpgToPdfFiles] = useState<File[]>([])
  const [organizePdfFile, setOrganizePdfFile] = useState<File | null>(null)
  const [organizePageOrder, setOrganizePageOrder] = useState<number[]>([])
  const [pageNumberFile, setPageNumberFile] = useState<File | null>(null)
  const [pageNumberFontSize, setPageNumberFontSize] = useState(12)
  const [rotatePdfFile, setRotatePdfFile] = useState<File | null>(null)
  const [rotatePdfDegrees, setRotatePdfDegrees] = useState(90)
  const rotatePdfEstimate = useMemo(
    () => (rotatePdfFile ? estimateSimilar(rotatePdfFile.size, 1.01) : null),
    [rotatePdfFile],
  )

  const [codeA, setCodeA] = useState('')
  const [codeB, setCodeB] = useState('')
  const [countInput, setCountInput] = useState('')
  const [toolSearch, setToolSearch] = useState('')
  const [category, setCategory] = useState<'all' | 'pdf' | 'image' | 'code' | 'text'>('all')
  const [isDraggingCrop, setIsDraggingCrop] = useState(false)
  const [cropDragStart, setCropDragStart] = useState<{ x: number; y: number } | null>(null)
  const cropFrameRef = useRef<HTMLDivElement | null>(null)
  const uploadProgressIntervalRef = useRef<number | null>(null)
  const uploadFinishTimeoutRef = useRef<number | null>(null)
  const uploadDoneTimeoutRef = useRef<number | null>(null)

  const reducePreview = useObjectUrl(reduceImageFile)
  const resizePreview = useObjectUrl(resizeImageFile)
  const cropPreview = useObjectUrl(cropImageFile)
  const rotatePreview = useObjectUrl(rotateImageFile)
  const signaturePreview = useObjectUrl(signatureImageFile)
  const dobPreview = useObjectUrl(dobImageFile)
  const borderPreview = useObjectUrl(borderImageFile)
  const rotateImageEstimate = useMemo(
    () => (rotateImageFile ? estimateSimilar(rotateImageFile.size, 1.02) : null),
    [rotateImageFile],
  )

  const diffChunks = useMemo(() => diffWords(codeA, codeB), [codeA, codeB])
  const currentTool = useMemo(() => tools.find((tool) => tool.id === activeTool)!, [activeTool])

  const compressionEstimate = useMemo(() => {
    if (!compressFile) return null
    const preset = compressionPreset === 'custom'
      ? { scale: customCompression, quality: 0.55 + customCompression / 2 }
      : compressionPresets[compressionPreset]
    return estimateCompressionSize(compressFile.size, preset)
  }, [compressFile, compressionPreset, customCompression])
  const navigate = useNavigate()
  const location = useLocation()

  const visibleTools = useMemo(() => {
    const query = toolSearch.trim().toLowerCase()
    return tools.filter((tool) => {
      const matchesCategory = category === 'all' || tool.category === category
      const matchesQuery =
        !query ||
        tool.label.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query) ||
        tool.tagline.toLowerCase().includes(query)
      return matchesCategory && matchesQuery
    })
  }, [category, toolSearch])

  const ImagePreview = ({ url, title }: { url: string | null; title: string }) => {
    if (!url) return null
    return (
      <div className="preview">
        <p className="muted tiny">{title}</p>
        <div className="preview-frame static small">
          <img src={url} alt={title} />
        </div>
      </div>
    )
  }

  const resetMessages = () => {
    setStatus('')
    setError('')
  }

  const clearUploadFeedbackTimers = () => {
    if (uploadProgressIntervalRef.current) {
      window.clearInterval(uploadProgressIntervalRef.current)
      uploadProgressIntervalRef.current = null
    }
    if (uploadFinishTimeoutRef.current) {
      window.clearTimeout(uploadFinishTimeoutRef.current)
      uploadFinishTimeoutRef.current = null
    }
    if (uploadDoneTimeoutRef.current) {
      window.clearTimeout(uploadDoneTimeoutRef.current)
      uploadDoneTimeoutRef.current = null
    }
  }

  const beginUploadFeedback = () => {
    clearUploadFeedbackTimers()
    setUploadComplete(false)
    setUploading(true)
    setUploadProgress(8)
    uploadProgressIntervalRef.current = window.setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 94) return prev
        const next = prev + Math.max(2, (94 - prev) * 0.24)
        return Math.min(94, next)
      })
    }, 90)
  }

  const finishUploadFeedback = () => {
    if (uploadProgressIntervalRef.current) {
      window.clearInterval(uploadProgressIntervalRef.current)
      uploadProgressIntervalRef.current = null
    }
    if (uploadFinishTimeoutRef.current) {
      window.clearTimeout(uploadFinishTimeoutRef.current)
      uploadFinishTimeoutRef.current = null
    }
    setUploadProgress(100)
    setUploading(false)
    setUploadComplete(true)
    uploadDoneTimeoutRef.current = window.setTimeout(() => {
      setUploadComplete(false)
      setUploadProgress(0)
      uploadDoneTimeoutRef.current = null
    }, 1400)
  }

  const onFileInputChangeCapture = (event: FormEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.type !== 'file') return
    if (!target.files || target.files.length === 0) return
    beginUploadFeedback()
    uploadFinishTimeoutRef.current = window.setTimeout(() => {
      finishUploadFeedback()
    }, 700)
  }

  useEffect(() => () => clearUploadFeedbackTimers(), [])

  useEffect(() => {
    const nextTool = getToolFromPath(location.pathname)
    if (nextTool !== activeTool) {
      setActiveTool(nextTool)
    }
  }, [activeTool, location.pathname])

  useEffect(() => {
    const nextPath = getToolPath(activeTool)
    if (location.pathname !== nextPath) {
      navigate(
        {
          pathname: nextPath,
          search: location.search,
        },
        {
          replace:
            location.pathname === '/' ||
            location.pathname === '/home' ||
            !location.pathname.startsWith('/tools/'),
        },
      )
    }
  }, [activeTool, location.pathname, location.search, navigate])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    if (isEmbedded) {
      document.body.classList.add('toolzite-embed')
      document.getElementById('root')?.classList.add('toolzite-embed-root')
    }

    return () => {
      document.body.classList.remove('toolzite-embed')
      document.getElementById('root')?.classList.remove('toolzite-embed-root')
    }
  }, [isEmbedded])

  useEffect(() => {
    if (!isEmbedded || typeof window === 'undefined') return undefined

    const postHeight = () => {
      window.parent.postMessage(
        {
          type: 'toolzite:embed-height',
          kind: 'pdf',
          height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        },
        '*',
      )
    }

    const postRoute = () => {
      window.parent.postMessage(
        {
          type: 'toolzite:embed-route',
          kind: 'pdf',
          path: window.location.pathname,
        },
        '*',
      )
    }

    const frame = window.requestAnimationFrame(() => {
      postRoute()
      postHeight()
    })

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => postHeight())
        : null

    resizeObserver?.observe(document.body)
    resizeObserver?.observe(document.documentElement)
    window.addEventListener('resize', postHeight)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', postHeight)
    }
  }, [activeTool, isEmbedded, location.pathname])

  const onCompressInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setCompressFile(file ?? null)
    resetMessages()
  }

  const onMergeInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    setMergeFiles(files ? Array.from(files) : [])
    resetMessages()
  }

  const onSplitInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setSplitFile(file ?? null)
    setSplitPageCount(null)
    setSplitEstimate(null)
    if (file) {
      file
        .arrayBuffer()
        .then((buffer) => getDocument({ data: buffer }).promise)
        .then((pdf) => setSplitPageCount(pdf.numPages))
        .catch(() => setSplitPageCount(null))
    }
    resetMessages()
  }

  const onOrganizeInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setOrganizePdfFile(file ?? null)
    resetMessages()
    if (!file) {
      setOrganizePageOrder([])
      return
    }
    const buffer = await file.arrayBuffer()
    const doc = await PDFDocument.load(buffer)
    setOrganizePageOrder(Array.from({ length: doc.getPageCount() }, (_, i) => i))
  }

  const moveMergeFile = (index: number, direction: -1 | 1) => {
    setMergeFiles((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  useEffect(() => {
    if (!reduceImageFile) {
      setReduceEstimate(null)
      return
    }
    setReduceEstimate(estimateImageScale(reduceImageFile.size, reduceScale * reduceScale, reduceQuality))
  }, [reduceImageFile, reduceScale, reduceQuality])

  useEffect(() => {
    if (!resizeImageFile || !resizeOriginalDims) {
      setResizeEstimate(null)
      return
    }
    const originalPixels = resizeOriginalDims.width * resizeOriginalDims.height
    const targetPixels = resizeWidth * resizeHeight
    const ratio = targetPixels / Math.max(1, originalPixels)
    setResizeEstimate(estimateImageScale(resizeImageFile.size, ratio))
  }, [resizeImageFile, resizeOriginalDims, resizeWidth, resizeHeight])

  useEffect(() => {
    if (!cropImageFile) {
      setCropEstimate(null)
      return
    }
    const ratio = (cropValues.width / 100) * (cropValues.height / 100)
    setCropEstimate(estimateImageScale(cropImageFile.size, ratio))
  }, [cropImageFile, cropValues.width, cropValues.height])

  useEffect(() => {
    if (!splitFile || !splitPageCount) {
      setSplitEstimate(null)
      return
    }
    try {
      const pages = parsePageRange(splitRange, splitPageCount)
      const ratio = pages.length / splitPageCount
      setSplitEstimate(estimateSimilar(splitFile.size, ratio))
    } catch {
      setSplitEstimate(null)
    }
  }, [splitFile, splitPageCount, splitRange])

  useEffect(() => {
    if (!signatureImageFile) {
      setSignatureEstimate(null)
      return
    }
    setSignatureEstimate(estimateSimilar(signatureImageFile.size, 1.05))
  }, [signatureImageFile, signatureText, signatureSize])

  useEffect(() => {
    if (!dobImageFile) {
      setDobEstimate(null)
      return
    }
    setDobEstimate(estimateSimilar(dobImageFile.size, 1.02))
  }, [dobImageFile, dobText])

  useEffect(() => {
    if (!borderImageFile) {
      setBorderEstimate(null)
      return
    }
    const multiplier = 1 + Math.min(0.8, (borderThickness * 4) / Math.max(100, borderImageFile.size))
    setBorderEstimate(estimateSimilar(borderImageFile.size, multiplier))
  }, [borderImageFile, borderThickness])

  const removeMergeFile = (index: number) => {
    setMergeFiles((prev) => prev.filter((_, i) => i !== index))
    resetMessages()
  }

  const movePageOrder = (index: number, direction: -1 | 1) => {
    setOrganizePageOrder((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const nudgeCrop = (delta: number) => {
    setCropValues((prev) => {
      const width = Math.min(100, Math.max(5, prev.width + delta))
      const height = Math.min(100, Math.max(5, prev.height + delta))
      const x = Math.min(prev.x, 100 - width)
      const y = Math.min(prev.y, 100 - height)
      return { ...prev, width, height, x, y }
    })
  }

  const startCropDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (!cropFrameRef.current || !cropPreview) return
    event.preventDefault()
    const rect = cropFrameRef.current.getBoundingClientRect()
    const startX = ((event.clientX - rect.left) / rect.width) * 100
    const startY = ((event.clientY - rect.top) / rect.height) * 100
    const clampedX = Math.min(100, Math.max(0, startX))
    const clampedY = Math.min(100, Math.max(0, startY))
    setCropDragStart({ x: clampedX, y: clampedY })
    setCropValues((prev) => ({ ...prev, x: clampedX, y: clampedY, width: 2, height: 2 }))
    setIsDraggingCrop(true)
  }

  const moveCropDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (!isDraggingCrop || !cropFrameRef.current || !cropDragStart) return
    const rect = cropFrameRef.current.getBoundingClientRect()
    const currentX = ((event.clientX - rect.left) / rect.width) * 100
    const currentY = ((event.clientY - rect.top) / rect.height) * 100
    const x1 = Math.min(100, Math.max(0, cropDragStart.x))
    const y1 = Math.min(100, Math.max(0, cropDragStart.y))
    const x2 = Math.min(100, Math.max(0, currentX))
    const y2 = Math.min(100, Math.max(0, currentY))
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const width = Math.max(2, Math.abs(x2 - x1))
    const height = Math.max(2, Math.abs(y2 - y1))
    setCropValues({ x: left, y: top, width, height })
  }

  const endCropDrag = () => {
    setIsDraggingCrop(false)
    setCropDragStart(null)
  }

  const compressPdf = async () => {
    if (!compressFile) return
    setIsProcessing(true)
    setError('')
    const preset =
      compressionPreset === 'custom'
        ? { label: 'Custom', scale: customCompression, quality: 0.55 + customCompression / 2, detail: '' }
        : compressionPresets[compressionPreset]
    setStatus(`Applying ${preset.label} compression…`)
    try {
      const buffer = await compressFile.arrayBuffer()
      const pdf = await getDocument({ data: buffer }).promise
      const output = await PDFDocument.create()
      const totalPages = pdf.numPages
      for (let i = 1; i <= totalPages; i += 1) {
        const page = await pdf.getPage(i)
        const originalViewport = page.getViewport({ scale: 1 })
        const scaledViewport = page.getViewport({ scale: preset.scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(scaledViewport.width))
        canvas.height = Math.max(1, Math.floor(scaledViewport.height))
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('Canvas not supported in this browser.')
        }
        await page.render({ canvasContext: context, viewport: scaledViewport, canvas }).promise
        const dataUrl = canvas.toDataURL('image/jpeg', preset.quality)
        const embedded = await output.embedJpg(dataUrl)
        const newPage = output.addPage([originalViewport.width, originalViewport.height])
        newPage.drawImage(embedded, {
          x: 0,
          y: 0,
          width: originalViewport.width,
          height: originalViewport.height,
        })
      }
      const bytes = await output.save({ useObjectStreams: true })
      downloadBlob(bytes, createOutputName(compressFile.name, compressionPreset))
      setStatus(
        `Compressed ${compressFile.name} to ${formatBytes(bytes.length)} (was ${formatBytes(
          compressFile.size,
        )}) with ${preset.label}`,
      )
    } catch (err) {
      setError((err as Error).message || 'Unable to compress this PDF.')
    } finally {
      setIsProcessing(false)
    }
  }

  const mergePdfs = async () => {
    if (mergeFiles.length < 2) {
      setError('Add two or more PDFs to merge.')
      return
    }
    setIsProcessing(true)
    setError('')
    setStatus('Copying pages into a unified PDF…')
    try {
      const merged = await PDFDocument.create()
      for (const file of mergeFiles) {
        const buffer = await file.arrayBuffer()
        const doc = await PDFDocument.load(buffer)
        const copied = await merged.copyPages(doc, doc.getPageIndices())
        copied.forEach((page) => merged.addPage(page))
      }
      const bytes = await merged.save({ useObjectStreams: true })
      const name = mergeFiles[0]?.name ? createOutputName(mergeFiles[0].name, 'merged') : 'merged.pdf'
      downloadBlob(bytes, name)
      const totalSize = mergeFiles.reduce((sum, file) => sum + file.size, 0)
      setStatus(`Merged ${mergeFiles.length} PDFs to ${formatBytes(bytes.length)} (input ${formatBytes(totalSize)})`)
    } catch (err) {
      setError((err as Error).message || 'Unable to merge these PDFs.')
    } finally {
      setIsProcessing(false)
    }
  }

  const splitPdf = async () => {
    if (!splitFile) {
      setError('Add a PDF to split.')
      return
    }
    setIsProcessing(true)
    setError('')
    setStatus('Extracting selected pages…')
    try {
      const buffer = await splitFile.arrayBuffer()
      const doc = await PDFDocument.load(buffer)
      const pagesToCopy = parsePageRange(splitRange, doc.getPageCount())
      const target = await PDFDocument.create()
      const copied = await target.copyPages(doc, pagesToCopy)
      copied.forEach((page) => target.addPage(page))
      const bytes = await target.save({ useObjectStreams: true })
      downloadBlob(bytes, createOutputName(splitFile.name, 'split'))
      setStatus(
        `Split out ${pagesToCopy.length} page${pagesToCopy.length === 1 ? '' : 's'} to ${formatBytes(
          bytes.length,
        )} (input ${formatBytes(splitFile.size)})`,
      )
    } catch (err) {
      setError((err as Error).message || 'Unable to split this PDF.')
    } finally {
      setIsProcessing(false)
    }
  }

  const reduceImageSize = async () => {
    if (!reduceImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Scaling image down carefully…')
    try {
      const image = await loadImageFromFile(reduceImageFile)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * reduceScale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * reduceScale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, 'image/jpeg', reduceQuality)
      downloadFile(blob, createOutputName(reduceImageFile.name, 'reduced', 'jpg'))
      setStatus(
        `Resized to ${canvas.width}×${canvas.height} at ${Math.round(reduceQuality * 100)}% quality (${formatBytes(
          blob.size,
        )})`,
      )
    } catch (err) {
      setError((err as Error).message || 'Unable to reduce image size.')
    } finally {
      setIsProcessing(false)
    }
  }

  const cropImage = async () => {
    if (!cropImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Cropping image…')
    try {
      const image = await loadImageFromFile(cropImageFile)
      const x = Math.max(0, Math.min(100, cropValues.x)) / 100
      const y = Math.max(0, Math.min(100, cropValues.y)) / 100
      const width = Math.max(1, Math.min(100, cropValues.width)) / 100
      const height = Math.max(1, Math.min(100, cropValues.height)) / 100
      const cropX = image.naturalWidth * x
      const cropY = image.naturalHeight * y
      const cropW = image.naturalWidth * width
      const cropH = image.naturalHeight * height
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(cropW))
      canvas.height = Math.max(1, Math.round(cropH))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.drawImage(image, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, 'image/png')
      downloadFile(blob, createOutputName(cropImageFile.name, 'cropped', 'png'))
      setStatus(`Cropped to ${canvas.width}×${canvas.height} (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to crop image.')
    } finally {
      setIsProcessing(false)
    }
  }

  const rotateImage = async () => {
    if (!rotateImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Rotating image…')
    try {
      const image = await loadImageFromFile(rotateImageFile)
      const radians = (rotateAngle * Math.PI) / 180
      const swap = rotateAngle % 180 !== 0
      const canvas = document.createElement('canvas')
      canvas.width = swap ? image.naturalHeight : image.naturalWidth
      canvas.height = swap ? image.naturalWidth : image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.translate(canvas.width / 2, canvas.height / 2)
      context.rotate(radians)
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
      const blob = await canvasToBlob(canvas, 'image/png')
      downloadFile(blob, createOutputName(rotateImageFile.name, `rotated-${rotateAngle}`, 'png'))
      setStatus(`Rotated ${rotateAngle}° (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to rotate image.')
    } finally {
      setIsProcessing(false)
    }
  }

  const resizeImagePixels = async () => {
    if (!resizeImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Resizing to requested pixels…')
    try {
      const image = await loadImageFromFile(resizeImageFile)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(resizeWidth))
      canvas.height = Math.max(1, Math.round(resizeHeight))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, 'image/png')
      downloadFile(blob, createOutputName(resizeImageFile.name, `${canvas.width}x${canvas.height}`, 'png'))
      setStatus(`Sized to ${canvas.width}×${canvas.height} (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to resize image.')
    } finally {
      setIsProcessing(false)
    }
  }

  const signImage = async () => {
    if (!signatureImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Stamping signature…')
    try {
      const image = await loadImageFromFile(signatureImageFile)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.drawImage(image, 0, 0)
      context.fillStyle = signatureColor
      context.font = `${signatureSize}px Space Grotesk, sans-serif`
      context.textBaseline = 'bottom'
      const padding = signatureSize * 0.8
      const metrics = context.measureText(signatureText)
      const x = canvas.width - metrics.width - padding
      const y = canvas.height - padding
      context.fillText(signatureText, x, y)
      const blob = await canvasToBlob(canvas, 'image/png')
      downloadFile(blob, createOutputName(signatureImageFile.name, 'signed', 'png'))
      setStatus(`Signature added (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to add signature.')
    } finally {
      setIsProcessing(false)
    }
  }

  const stampDob = async () => {
    if (!dobImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Stamping DOB…')
    try {
      const image = await loadImageFromFile(dobImageFile)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.drawImage(image, 0, 0)
      context.fillStyle = dobColor
      context.font = `16px Space Grotesk, sans-serif`
      context.textBaseline = 'top'
      const padding = 14
      context.fillText(dobText, padding, padding)
      const blob = await canvasToBlob(canvas, 'image/png')
      downloadFile(blob, createOutputName(dobImageFile.name, 'dob', 'png'))
      setStatus(`DOB stamped (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to stamp DOB.')
    } finally {
      setIsProcessing(false)
    }
  }

  const addImageBorder = async () => {
    if (!borderImageFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Adding border…')
    try {
      const image = await loadImageFromFile(borderImageFile)
      const thickness = Math.max(1, borderThickness)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth + thickness * 2
      canvas.height = image.naturalHeight + thickness * 2
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas not supported.')
      context.fillStyle = borderColor
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, thickness, thickness)
      const blob = await canvasToBlob(canvas, 'image/png')
      downloadFile(blob, createOutputName(borderImageFile.name, 'border', 'png'))
      setStatus(`Border added (${thickness}px, ${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to add border.')
    } finally {
      setIsProcessing(false)
    }
  }

  const pdfToWord = async () => {
    if (!pdfToWordFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Extracting text into DOCX…')
    try {
      const buffer = await pdfToWordFile.arrayBuffer()
      const pdf = await getDocument({ data: buffer }).promise
      const pieces: string[] = []
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i)
        const textContent = await page.getTextContent()
        const strings = textContent.items
          .map((item) => ('str' in item ? item.str : ''))
          .filter(Boolean)
          .join(' ')
        pieces.push(strings)
      }
      const doc = new DocxDocument({
        sections: [
          {
            children: pieces.flatMap((chunk) => chunk.split('\n').map((line) => new Paragraph(line || ' '))),
          },
        ],
      })
      const blob = await Packer.toBlob(doc)
      const name = createOutputName(pdfToWordFile.name, 'word', 'docx')
      downloadFile(blob, name)
      setStatus(`DOCX ready (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to convert PDF to Word.')
    } finally {
      setIsProcessing(false)
    }
  }

  const pdfToJpg = async () => {
    if (!pdfToJpgFile) return
    setIsProcessing(true)
    setError('')
    setStatus('Rendering pages to JPG…')
    try {
      const buffer = await pdfToJpgFile.arrayBuffer()
      const pdf = await getDocument({ data: buffer }).promise
      const zip = new JSZip()
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: 1.1 })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas not supported.')
        await page.render({ canvasContext: context, viewport, canvas }).promise
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
        const base64 = dataUrl.split(',')[1]
        zip.file(`page-${i}.jpg`, base64, { base64: true })
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const name = createOutputName(pdfToJpgFile.name, 'jpg-bundle', 'zip')
      downloadFile(blob, name)
      setStatus(`Rendered ${pdf.numPages} page(s) to JPG ZIP (${formatBytes(blob.size)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to convert PDF to JPG.')
    } finally {
      setIsProcessing(false)
    }
  }

  const jpgToPdf = async () => {
    if (jpgToPdfFiles.length === 0) {
      setError('Add one or more images.')
      return
    }
    setIsProcessing(true)
    setError('')
    setStatus('Embedding images into PDF…')
    try {
      const doc = await PDFDocument.create()
      for (const file of jpgToPdfFiles) {
        const buffer = await file.arrayBuffer()
        const image = file.type.includes('png') ? await doc.embedPng(buffer) : await doc.embedJpg(buffer)
        const page = doc.addPage([image.width, image.height])
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
      }
      const bytes = await doc.save({ useObjectStreams: true })
      downloadBlob(bytes, createOutputName(jpgToPdfFiles[0].name, 'as-pdf'))
      const totalSize = jpgToPdfFiles.reduce((sum, file) => sum + file.size, 0)
      setStatus(
        `Created PDF with ${jpgToPdfFiles.length} image${
          jpgToPdfFiles.length > 1 ? 's' : ''
        } (${formatBytes(bytes.length)}, input ${formatBytes(totalSize)}).`,
      )
    } catch (err) {
      setError((err as Error).message || 'Unable to convert images to PDF.')
    } finally {
      setIsProcessing(false)
    }
  }

  const reorderPdf = async () => {
    if (!organizePdfFile || organizePageOrder.length === 0) {
      setError('Load a PDF to reorder.')
      return
    }
    setIsProcessing(true)
    setError('')
    setStatus('Reordering pages…')
    try {
      const buffer = await organizePdfFile.arrayBuffer()
      const doc = await PDFDocument.load(buffer)
      const target = await PDFDocument.create()
      const copied = await target.copyPages(doc, organizePageOrder)
      copied.forEach((page) => target.addPage(page))
      const bytes = await target.save({ useObjectStreams: true })
      downloadBlob(bytes, createOutputName(organizePdfFile.name, 'reordered'))
      setStatus(`Page order updated (${formatBytes(bytes.length)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to reorder pages.')
    } finally {
      setIsProcessing(false)
    }
  }

  const rotatePdfPages = async () => {
    if (!rotatePdfFile) {
      setError('Load a PDF to rotate.')
      return
    }
    setIsProcessing(true)
    setError('')
    setStatus('Rotating PDF pages…')
    try {
      const buffer = await rotatePdfFile.arrayBuffer()
      const doc = await PDFDocument.load(buffer)
      doc.getPages().forEach((page) => {
        const current = page.getRotation().angle
        page.setRotation(degrees((current + rotatePdfDegrees) % 360))
      })
      const bytes = await doc.save({ useObjectStreams: true })
      downloadBlob(bytes, createOutputName(rotatePdfFile.name, `rotated-${rotatePdfDegrees}`))
      setStatus(`Rotated pages by ${rotatePdfDegrees}° (${formatBytes(bytes.length)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to rotate PDF.')
    } finally {
      setIsProcessing(false)
    }
  }

  const addPageNumbers = async () => {
    if (!pageNumberFile) {
      setError('Load a PDF to number.')
      return
    }
    setIsProcessing(true)
    setError('')
    setStatus('Adding page numbers…')
    try {
      const buffer = await pageNumberFile.arrayBuffer()
      const doc = await PDFDocument.load(buffer)
      const font = await doc.embedFont(StandardFonts.Helvetica)
      doc.getPages().forEach((page, index) => {
        const { width } = page.getSize()
        const size = pageNumberFontSize
        const text = `${index + 1}`
        const textWidth = font.widthOfTextAtSize(text, size)
        page.drawText(text, {
          x: width / 2 - textWidth / 2,
          y: 22,
          size,
          font,
          color: rgb(0.1, 0.12, 0.2),
        })
      })
      const bytes = await doc.save({ useObjectStreams: true })
      downloadBlob(bytes, createOutputName(pageNumberFile.name, 'numbered'))
      setStatus(`Page numbers added (${formatBytes(bytes.length)}).`)
    } catch (err) {
      setError((err as Error).message || 'Unable to add page numbers.')
    } finally {
      setIsProcessing(false)
    }
  }

  const renderCompressTool = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Slim down</p>
          <h3>Compression</h3>
        </div>
        {compressFile && <span className="chip">{formatBytes(compressFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="application/pdf" onChange={onCompressInput} />
        <div>
          <p className="drop-title">Drop a PDF or click to choose</p>
          <p className="muted">Optimized for clarity across presets.</p>
        </div>
        {compressFile && <div className="file-pill">{compressFile.name}</div>}
      </label>
      <div className="pill-row">
        {mergeFiles.length > 0 && (
          <div className="pill">
            <span className="pill-title">
              {formatBytes(mergeFiles.reduce((sum, f) => sum + f.size, 0))}
            </span>
            <span className="pill-sub">Total input</span>
          </div>
        )}
        {mergeFiles.length > 0 && (
          <div className="pill">
            <span className="pill-title">
              {formatBytes(estimateSimilar(mergeFiles.reduce((sum, f) => sum + f.size, 0), 1.02))}
            </span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <div className="pill-row">
        {Object.entries(compressionPresets).map(([key, preset]) => (
          <button
            key={key}
            className={`pill ${compressionPreset === key ? 'pill-active' : ''}`}
            onClick={() => setCompressionPreset(key as CompressionPreset)}
          >
            <span className="pill-title">{preset.label}</span>
            <span className="pill-sub">{preset.detail}</span>
          </button>
        ))}
      </div>
      <div className="control">
        <div className="control-row">
          <label htmlFor="compression-range">Fine tune</label>
          <span className="muted tiny">{compressionPreset.toUpperCase()}</span>
        </div>
        <div className="grid-2">
          <input
            id="compression-range"
            type="range"
            min={0}
            max={3}
            step={1}
            value={Object.keys(compressionPresets).indexOf(compressionPreset)}
            onChange={(event) => {
              const index = Number(event.target.value)
              const key = Object.keys(compressionPresets)[index] as CompressionChoice
              setCompressionPreset(key)
            }}
          />
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            disabled={compressionPreset !== 'custom'}
            value={customCompression}
            onChange={(event) => setCustomCompression(Number(event.target.value))}
          />
        </div>
        <p className="muted tiny">
          Low keeps clarity, Medium balances, High shrinks more without blurring. Custom lets you pick scale/quality in 5%
          steps. Est. size: {compressionEstimate ? formatBytes(compressionEstimate) : '—'}
        </p>
      </div>
      <div className="pill-row">
        {compressFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(compressFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {compressionEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(compressionEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <button className="action" disabled={!compressFile || isProcessing} onClick={compressPdf}>
        {isProcessing ? 'Working…' : 'Compress & download'}
      </button>
    </section>
  )

  const renderMergeTool = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Combine</p>
          <h3>Merge PDFs</h3>
        </div>
        {mergeFiles.length > 0 && <span className="chip">{mergeFiles.length} file(s)</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="application/pdf" multiple onChange={onMergeInput} />
        <div>
          <p className="drop-title">Choose two or more PDFs</p>
          <p className="muted">Reorder below to set the merge order.</p>
        </div>
      </label>
      <div className="file-list">
        {mergeFiles.map((file, index) => (
          <div key={file.name + index} className="file-row">
            <div>
              <p className="file-name">{file.name}</p>
              <p className="muted tiny">{formatBytes(file.size)}</p>
            </div>
            <div className="file-actions">
              <button
                className="ghost"
                onClick={() => moveMergeFile(index, -1)}
                aria-label="Move up"
                disabled={index === 0}
              >
                ↑
              </button>
              <button
                className="ghost"
                onClick={() => moveMergeFile(index, 1)}
                aria-label="Move down"
                disabled={index === mergeFiles.length - 1}
              >
                ↓
              </button>
              <button className="ghost danger" onClick={() => removeMergeFile(index)} aria-label="Remove file">
                ✕
              </button>
            </div>
          </div>
        ))}
        {mergeFiles.length === 0 && <p className="muted tiny">No files yet. Add PDFs to begin.</p>}
      </div>
      <button className="action" disabled={mergeFiles.length < 2 || isProcessing} onClick={mergePdfs}>
        {isProcessing ? 'Working…' : 'Merge & download'}
      </button>
    </section>
  )

  const renderSplitTool = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Extract</p>
          <h3>Split PDF</h3>
        </div>
        {splitFile && <span className="chip">{formatBytes(splitFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="application/pdf" onChange={onSplitInput} />
        <div>
          <p className="drop-title">Choose a PDF to split</p>
          <p className="muted">Keeps original safe—only the extracted pages are saved.</p>
        </div>
        {splitFile && <div className="file-pill">{splitFile.name}</div>}
      </label>
      <div className="control">
        <div className="control-row">
          <label htmlFor="range-input">Pages to extract</label>
          <span className="muted tiny">e.g. 1-3,7</span>
        </div>
        <input
          id="range-input"
          type="text"
          value={splitRange}
          onChange={(event) => setSplitRange(event.target.value)}
          placeholder="1-3,7"
        />
      </div>
      <div className="pill-row">
        {splitFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(splitFile.size)}</span>
            <span className="pill-sub">Input</span>
          </div>
        )}
        {splitEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(splitEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <button className="action" disabled={!splitFile || isProcessing} onClick={splitPdf}>
        {isProcessing ? 'Working…' : 'Split & download'}
      </button>
    </section>
  )

  const renderPdfToJpg = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Convert</p>
          <h3>PDF → JPG ZIP</h3>
        </div>
        {pdfToJpgFile && <span className="chip">{formatBytes(pdfToJpgFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="application/pdf" onChange={(e) => setPdfToJpgFile(e.target.files?.[0] ?? null)} />
        <div>
          <p className="drop-title">Choose a PDF</p>
          <p className="muted tiny">Each page becomes a JPG inside a ZIP archive.</p>
        </div>
        {pdfToJpgFile && <div className="file-pill">{pdfToJpgFile.name}</div>}
      </label>
      <div className="pill-row">
        {pdfToJpgFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(pdfToJpgFile.size)}</span>
            <span className="pill-sub">Input</span>
          </div>
        )}
        {pdfToJpgFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(estimateSimilar(pdfToJpgFile.size, 1.4))}</span>
            <span className="pill-sub">Est. output ZIP</span>
          </div>
        )}
      </div>
      <button className="action" disabled={!pdfToJpgFile || isProcessing} onClick={pdfToJpg}>
        {isProcessing ? 'Working…' : 'Convert to JPG ZIP'}
      </button>
    </section>
  )

  const renderJpgToPdf = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Convert</p>
          <h3>Images → PDF</h3>
        </div>
        {jpgToPdfFiles.length > 0 && <span className="chip">{jpgToPdfFiles.length} image(s)</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input
          type="file"
          accept="image/png, image/jpeg"
          multiple
          onChange={(e) => setJpgToPdfFiles(e.target.files ? Array.from(e.target.files) : [])}
        />
        <div>
          <p className="drop-title">Add JPG/PNG files</p>
          <p className="muted tiny">Order respected as selected.</p>
        </div>
      </label>
      <div className="pill-row">
        {jpgToPdfFiles.length > 0 && (
          <div className="pill">
            <span className="pill-title">
              {formatBytes(jpgToPdfFiles.reduce((sum, f) => sum + f.size, 0))}
            </span>
            <span className="pill-sub">Total input</span>
          </div>
        )}
        {jpgToPdfFiles.length > 0 && (
          <div className="pill">
            <span className="pill-title">
              {formatBytes(estimateSimilar(jpgToPdfFiles.reduce((sum, f) => sum + f.size, 0), 1.1))}
            </span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <button className="action" disabled={jpgToPdfFiles.length === 0 || isProcessing} onClick={jpgToPdf}>
        {isProcessing ? 'Working…' : 'Build PDF'}
      </button>
    </section>
  )

  const renderOrganizePdf = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Arrange</p>
          <h3>Organize PDF pages</h3>
        </div>
        {organizePageOrder.length > 0 && <span className="chip">{organizePageOrder.length} page(s)</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="application/pdf" onChange={onOrganizeInput} />
        <div>
          <p className="drop-title">Choose a PDF</p>
          <p className="muted tiny">Reorder pages using the arrows.</p>
        </div>
        {organizePdfFile && <div className="file-pill">{organizePdfFile.name}</div>}
      </label>
      <div className="pill-row">
        {organizePdfFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(organizePdfFile.size)}</span>
            <span className="pill-sub">Input</span>
          </div>
        )}
        {organizePdfFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(estimateSimilar(organizePdfFile.size, 1.02))}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <div className="file-list">
        {organizePageOrder.map((pageNumber, index) => (
          <div key={pageNumber} className="file-row">
            <div className="number-badge">Page {pageNumber + 1}</div>
            <div className="file-actions">
              <button
                className="ghost"
                onClick={() => movePageOrder(index, -1)}
                aria-label="Move up"
                disabled={index === 0}
              >
                ↑
              </button>
              <button
                className="ghost"
                onClick={() => movePageOrder(index, 1)}
                aria-label="Move down"
                disabled={index === organizePageOrder.length - 1}
              >
                ↓
              </button>
            </div>
          </div>
        ))}
        {organizePageOrder.length === 0 && <p className="muted tiny">Load a PDF to see pages.</p>}
      </div>
      <button className="action" disabled={!organizePdfFile || isProcessing} onClick={reorderPdf}>
        {isProcessing ? 'Working…' : 'Reorder & download'}
      </button>
    </section>
  )

  const renderRotatePdf = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Rotate</p>
          <h3>Rotate PDF</h3>
        </div>
        {rotatePdfFile && <span className="chip">{formatBytes(rotatePdfFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="application/pdf" onChange={(e) => setRotatePdfFile(e.target.files?.[0] ?? null)} />
        <div>
          <p className="drop-title">Choose a PDF</p>
          <p className="muted tiny">Applies to every page.</p>
        </div>
        {rotatePdfFile && <div className="file-pill">{rotatePdfFile.name}</div>}
      </label>
      <div className="control">
        <div className="control-row">
          <label htmlFor="rotate-pdf">Degrees</label>
          <span className="muted tiny">90 / 180 / 270</span>
        </div>
        <select
          id="rotate-pdf"
          value={rotatePdfDegrees}
          onChange={(e) => setRotatePdfDegrees(Number(e.target.value))}
        >
          <option value={90}>90°</option>
          <option value={180}>180°</option>
          <option value={270}>270°</option>
        </select>
      </div>
      <div className="pill-row">
        {rotatePdfFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(rotatePdfFile.size)}</span>
            <span className="pill-sub">Input</span>
          </div>
        )}
        {rotatePdfEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(rotatePdfEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <button className="action" disabled={!rotatePdfFile || isProcessing} onClick={rotatePdfPages}>
        {isProcessing ? 'Working…' : 'Rotate & download'}
      </button>
    </section>
  )

  const renderPageNumbers = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Label</p>
          <h3>Page numbers</h3>
        </div>
        {pageNumberFile && <span className="chip">{formatBytes(pageNumberFile.size)}</span>}
      </div>
      <label className="dropzone">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setPageNumberFile(e.target.files?.[0] ?? null)}
        />
        <div>
          <p className="drop-title">Choose a PDF</p>
          <p className="muted tiny">Numbers are placed at the bottom center.</p>
        </div>
        {pageNumberFile && <div className="file-pill">{pageNumberFile.name}</div>}
      </label>
      <div className="control">
        <label htmlFor="font-size">Font size</label>
        <input
          id="font-size"
          type="number"
          min={8}
          max={32}
          value={pageNumberFontSize}
          onChange={(e) => setPageNumberFontSize(Number(e.target.value))}
        />
      </div>
      <div className="pill-row">
        {pageNumberFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(pageNumberFile.size)}</span>
            <span className="pill-sub">Input</span>
          </div>
        )}
        {pageNumberFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(estimateSimilar(pageNumberFile.size, 1.03))}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <button className="action" disabled={!pageNumberFile || isProcessing} onClick={addPageNumbers}>
        {isProcessing ? 'Working…' : 'Add numbers & download'}
      </button>
    </section>
  )

  const renderPdfToWord = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Extract</p>
          <h3>PDF → Word</h3>
        </div>
        {pdfToWordFile && <span className="chip">{formatBytes(pdfToWordFile.size)}</span>}
      </div>
      <label className="dropzone">
        <input type="file" accept="application/pdf" onChange={(e) => setPdfToWordFile(e.target.files?.[0] ?? null)} />
        <div>
          <p className="drop-title">Choose a PDF</p>
          <p className="muted tiny">Pulls text only—images are skipped.</p>
        </div>
        {pdfToWordFile && <div className="file-pill">{pdfToWordFile.name}</div>}
      </label>
      <div className="pill-row">
        {pdfToWordFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(pdfToWordFile.size)}</span>
            <span className="pill-sub">Input</span>
          </div>
        )}
        {pdfToWordFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(estimateSimilar(pdfToWordFile.size, 0.4) + 15000)}</span>
            <span className="pill-sub">Est. DOCX</span>
          </div>
        )}
      </div>
      <button className="action" disabled={!pdfToWordFile || isProcessing} onClick={pdfToWord}>
        {isProcessing ? 'Working…' : 'Convert to DOCX'}
      </button>
    </section>
  )

  const renderReduceImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Reduce size</h3>
        </div>
        {reduceImageFile && <span className="chip">{formatBytes(reduceImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="image/png, image/jpeg" onChange={(e) => setReduceImageFile(e.target.files?.[0] ?? null)} />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">Scales down gently to avoid blur.</p>
        </div>
        {reduceImageFile && <div className="file-pill">{reduceImageFile.name}</div>}
      </label>
      <div className="control grid-2">
        <div>
          <div className="control-row">
            <label htmlFor="reduce-scale">Scale</label>
            <span className="muted tiny">{Math.round(reduceScale * 100)}%</span>
          </div>
          <input
            id="reduce-scale"
            type="range"
            min={0.5}
            max={1}
            step={0.05}
            value={reduceScale}
            onChange={(e) => setReduceScale(Number(e.target.value))}
          />
        </div>
        <div>
          <div className="control-row">
            <label htmlFor="reduce-quality">Quality</label>
            <span className="muted tiny">{Math.round(reduceQuality * 100)}%</span>
          </div>
          <input
            id="reduce-quality"
            type="range"
            min={0.6}
            max={0.95}
            step={0.01}
            value={reduceQuality}
            onChange={(e) => setReduceQuality(Number(e.target.value))}
          />
        </div>
      </div>
      <div className="pill-row">
        {reduceImageFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(reduceImageFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {reduceEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(reduceEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <ImagePreview url={reducePreview} title="Preview" />
      <button className="action" disabled={!reduceImageFile || isProcessing} onClick={reduceImageSize}>
        {isProcessing ? 'Working…' : 'Reduce & download'}
      </button>
    </section>
  )

  const renderResizeImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Adjust pixels</h3>
        </div>
        {resizeImageFile && <span className="chip">{formatBytes(resizeImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input
          type="file"
          accept="image/png, image/jpeg"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            setResizeImageFile(file ?? null)
            if (file) {
              const image = await loadImageFromFile(file)
              setResizeWidth(image.naturalWidth)
              setResizeHeight(image.naturalHeight)
              setResizeOriginalDims({ width: image.naturalWidth, height: image.naturalHeight })
              setResizeEstimate(estimateImageScale(file.size, 1))
            } else {
              setResizeOriginalDims(null)
              setResizeEstimate(null)
            }
          }}
        />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">Set exact pixel dimensions.</p>
        </div>
        {resizeImageFile && <div className="file-pill">{resizeImageFile.name}</div>}
      </label>
      <div className="grid-2">
        <div className="control">
          <label htmlFor="resize-width">Width (px)</label>
          <input
            id="resize-width"
            type="number"
            min={1}
            value={resizeWidth}
            onChange={(e) => setResizeWidth(Number(e.target.value))}
          />
        </div>
        <div className="control">
          <label htmlFor="resize-height">Height (px)</label>
          <input
            id="resize-height"
            type="number"
            min={1}
            value={resizeHeight}
            onChange={(e) => setResizeHeight(Number(e.target.value))}
          />
        </div>
      </div>
      <div className="pill-row">
        {resizeImageFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(resizeImageFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {resizeEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(resizeEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <ImagePreview url={resizePreview} title="Preview" />
      <button className="action" disabled={!resizeImageFile || isProcessing} onClick={resizeImagePixels}>
        {isProcessing ? 'Working…' : 'Resize & download'}
      </button>
    </section>
  )

  const renderCropImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Crop</h3>
        </div>
        {cropImageFile && <span className="chip">{formatBytes(cropImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input
          type="file"
          accept="image/png, image/jpeg"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null
            setCropImageFile(file)
            setCropValues(defaultCropValues)
          }}
        />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">Starts at centered 50% x 50%. Drag on preview to adjust.</p>
        </div>
        {cropImageFile && <div className="file-pill">{cropImageFile.name}</div>}
      </label>
      {cropPreview && (
        <div className="preview">
          <div className="control-row">
            <p className="muted tiny">Preview (drag to select)</p>
            {isDraggingCrop && <span className="chip">Adjusting…</span>}
          </div>
          <div
            className={`preview-frame interactive small ${isDraggingCrop ? 'dragging' : ''}`}
            ref={cropFrameRef}
            onMouseDown={startCropDrag}
            onMouseMove={moveCropDrag}
            onMouseUp={endCropDrag}
            onMouseLeave={endCropDrag}
          >
            <img src={cropPreview} alt="Crop preview" />
            <div
              className="crop-overlay"
              style={{
                left: `${cropValues.x}%`,
                top: `${cropValues.y}%`,
                width: `${cropValues.width}%`,
                height: `${cropValues.height}%`,
              }}
            >
              <span className="handle" />
            </div>
          </div>
          <div className="pill-row">
            {cropImageFile && (
              <div className="pill">
                <span className="pill-title">{formatBytes(cropImageFile.size)}</span>
                <span className="pill-sub">Original</span>
              </div>
            )}
            {cropEstimate && (
              <div className="pill">
                <span className="pill-title">{formatBytes(cropEstimate)}</span>
                <span className="pill-sub">Est. output</span>
              </div>
            )}
          </div>
          <div className="pill-row">
            <button className="pill" onClick={() => nudgeCrop(5)}>
              <span className="pill-title">Expand</span>
              <span className="pill-sub">Grow box</span>
            </button>
            <button className="pill" onClick={() => nudgeCrop(-5)}>
              <span className="pill-title">Shrink</span>
              <span className="pill-sub">Tighter focus</span>
            </button>
          </div>
        </div>
      )}
      <button className="action" disabled={!cropImageFile || isProcessing} onClick={cropImage}>
        {isProcessing ? 'Working…' : 'Crop & download'}
      </button>
    </section>
  )

  const renderRotateImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Rotate</h3>
        </div>
        {rotateImageFile && <span className="chip">{formatBytes(rotateImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="image/png, image/jpeg" onChange={(e) => setRotateImageFile(e.target.files?.[0] ?? null)} />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">Rotate by right angles.</p>
        </div>
        {rotateImageFile && <div className="file-pill">{rotateImageFile.name}</div>}
      </label>
      <div className="control">
        <div className="control-row">
          <label>Rotation</label>
          <span className="muted tiny">{rotateAngle}° selected</span>
        </div>
        <div className="rotate-angle-options">
          {[
            { value: 270, icon: '↺', label: 'Left' },
            { value: 180, icon: '⟲', label: 'Half turn' },
            { value: 90, icon: '↻', label: 'Right' },
          ].map((option) => (
            <button
              key={option.value}
              className={`ghost rotate-angle-btn ${rotateAngle === option.value ? 'active' : ''}`}
              onClick={() => setRotateAngle(option.value)}
              aria-label={`${option.label} rotation`}
            >
              <span className="rotate-angle-icon" aria-hidden>
                {option.icon}
              </span>
              <span className="rotate-angle-label">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="pill-row">
        {rotateImageFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(rotateImageFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {rotateImageEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(rotateImageEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      {rotatePreview && (
        <div className="preview">
          <div className="control-row">
            <p className="muted tiny">Preview (live)</p>
            <span className="chip">{rotateAngle}°</span>
          </div>
          <div className="preview-frame small rotate-preview-frame">
            <img
              src={rotatePreview}
              alt="Rotate preview"
              style={{ transform: `rotate(${rotateAngle}deg)` }}
            />
          </div>
        </div>
      )}
      <button className="action" disabled={!rotateImageFile || isProcessing} onClick={rotateImage}>
        {isProcessing ? 'Working…' : 'Rotate & download'}
      </button>
    </section>
  )

  const renderSignatureImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Add signature</h3>
        </div>
        {signatureImageFile && <span className="chip">{formatBytes(signatureImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input
          type="file"
          accept="image/png, image/jpeg"
          onChange={(e) => setSignatureImageFile(e.target.files?.[0] ?? null)}
        />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">Signature goes bottom-right.</p>
        </div>
        {signatureImageFile && <div className="file-pill">{signatureImageFile.name}</div>}
      </label>
      <div className="grid-2">
        <div className="control">
          <label htmlFor="sign-text">Signature text</label>
          <input
            id="sign-text"
            type="text"
            value={signatureText}
            onChange={(e) => setSignatureText(e.target.value)}
          />
        </div>
        <div className="control">
          <label htmlFor="sign-color">Color</label>
          <input
            id="sign-color"
            type="color"
            value={signatureColor}
            onChange={(e) => setSignatureColor(e.target.value)}
          />
        </div>
      </div>
      <div className="control">
        <label htmlFor="sign-size">Font size</label>
        <input
          id="sign-size"
          type="number"
          min={8}
          max={64}
          value={signatureSize}
          onChange={(e) => setSignatureSize(Number(e.target.value))}
        />
      </div>
      <div className="pill-row">
        {signatureImageFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(signatureImageFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {signatureEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(signatureEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <ImagePreview url={signaturePreview} title="Preview" />
      <button className="action" disabled={!signatureImageFile || isProcessing} onClick={signImage}>
        {isProcessing ? 'Working…' : 'Add signature & download'}
      </button>
    </section>
  )

  const renderDobImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Add DOB</h3>
        </div>
        {dobImageFile && <span className="chip">{formatBytes(dobImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input type="file" accept="image/png, image/jpeg" onChange={(e) => setDobImageFile(e.target.files?.[0] ?? null)} />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">DOB text goes top-left.</p>
        </div>
        {dobImageFile && <div className="file-pill">{dobImageFile.name}</div>}
      </label>
      <div className="grid-2">
        <div className="control">
          <label htmlFor="dob-text">DOB text</label>
          <input id="dob-text" type="text" value={dobText} onChange={(e) => setDobText(e.target.value)} />
        </div>
        <div className="control">
          <label htmlFor="dob-color">Color</label>
          <input
            id="dob-color"
            type="color"
            value={dobColor}
            onChange={(e) => setDobColor(e.target.value)}
          />
        </div>
      </div>
      <div className="pill-row">
        {dobImageFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(dobImageFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {dobEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(dobEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <ImagePreview url={dobPreview} title="Preview" />
      <button className="action" disabled={!dobImageFile || isProcessing} onClick={stampDob}>
        {isProcessing ? 'Working…' : 'Add DOB & download'}
      </button>
    </section>
  )

  const renderBorderImage = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Image</p>
          <h3>Add border</h3>
        </div>
        {borderImageFile && <span className="chip">{formatBytes(borderImageFile.size)}</span>}
      </div>
      <label className={`dropzone ${uploading ? 'is-uploading' : ''}`}>
        <input
          type="file"
          accept="image/png, image/jpeg"
          onChange={(e) => setBorderImageFile(e.target.files?.[0] ?? null)}
        />
        <div>
          <p className="drop-title">Choose an image</p>
          <p className="muted tiny">Frame it with a clean border.</p>
        </div>
        {borderImageFile && <div className="file-pill">{borderImageFile.name}</div>}
      </label>
      <div className="grid-2">
        <div className="control">
          <label htmlFor="border-thickness">Thickness (px)</label>
          <input
            id="border-thickness"
            type="number"
            min={1}
            max={200}
            value={borderThickness}
            onChange={(e) => setBorderThickness(Number(e.target.value))}
          />
        </div>
        <div className="control">
          <label htmlFor="border-color">Color</label>
          <input
            id="border-color"
            type="color"
            value={borderColor}
            onChange={(e) => setBorderColor(e.target.value)}
          />
        </div>
      </div>
      <div className="pill-row">
        {borderImageFile && (
          <div className="pill">
            <span className="pill-title">{formatBytes(borderImageFile.size)}</span>
            <span className="pill-sub">Original</span>
          </div>
        )}
        {borderEstimate && (
          <div className="pill">
            <span className="pill-title">{formatBytes(borderEstimate)}</span>
            <span className="pill-sub">Est. output</span>
          </div>
        )}
      </div>
      <ImagePreview url={borderPreview} title="Preview" />
      <button className="action" disabled={!borderImageFile || isProcessing} onClick={addImageBorder}>
        {isProcessing ? 'Working…' : 'Add border & download'}
      </button>
    </section>
  )

  const renderCodeDiff = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Compare</p>
          <h3>Code diff checker</h3>
        </div>
      </div>
      <div className="grid-2">
        <div className="control">
          <label htmlFor="code-a">Original</label>
          <textarea
            id="code-a"
            className="text-area"
            value={codeA}
            onChange={(e) => setCodeA(e.target.value)}
            placeholder="Old version…"
          />
        </div>
        <div className="control">
          <label htmlFor="code-b">Changed</label>
          <textarea
            id="code-b"
            className="text-area"
            value={codeB}
            onChange={(e) => setCodeB(e.target.value)}
            placeholder="New version…"
          />
        </div>
      </div>
      <div className="diff-result">
        {diffChunks.map((chunk, index) => {
          if (chunk.added) {
            return (
              <span key={index} className="diff-add">
                {chunk.value}
              </span>
            )
          }
          if (chunk.removed) {
            return (
              <span key={index} className="diff-remove">
                {chunk.value}
              </span>
            )
          }
          return <span key={index}>{chunk.value}</span>
        })}
      </div>
    </section>
  )

  const renderCountText = () => {
    const words = countInput.trim() ? countInput.trim().split(/\s+/).length : 0
    const characters = countInput.length
    const lines = countInput ? countInput.split(/\n/).length : 0
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Text</p>
            <h3>Word & character count</h3>
          </div>
        </div>
        <textarea
          className="text-area"
          value={countInput}
          onChange={(e) => setCountInput(e.target.value)}
          placeholder="Paste text to count…"
        />
        <div className="pill-row">
          <div className="pill">
            <span className="pill-title">{words}</span>
            <span className="pill-sub">Words</span>
          </div>
          <div className="pill">
            <span className="pill-title">{characters}</span>
            <span className="pill-sub">Characters</span>
          </div>
          <div className="pill">
            <span className="pill-title">{lines}</span>
            <span className="pill-sub">Lines</span>
          </div>
        </div>
      </section>
    )
  }

  const toolRenderers = {
    compress: renderCompressTool,
    merge: renderMergeTool,
    split: renderSplitTool,
    'pdf-to-jpg': renderPdfToJpg,
    'jpg-to-pdf': renderJpgToPdf,
    'organize-pdf': renderOrganizePdf,
    'rotate-pdf': renderRotatePdf,
    'page-numbers': renderPageNumbers,
    'pdf-to-word': renderPdfToWord,
    'image-reduce': renderReduceImage,
    'image-resize': renderResizeImage,
    'image-crop': renderCropImage,
    'image-rotate': renderRotateImage,
    'image-signature': renderSignatureImage,
    'image-dob': renderDobImage,
    'image-border': renderBorderImage,
    'code-diff': renderCodeDiff,
    'count-text': renderCountText,
  } satisfies Record<ToolKey, () => ReactNode>

  const renderActiveTool = () => toolRenderers[activeTool]()

  const workspaceStyle = { '--upload-progress': `${uploadProgress}%` } as CSSProperties

  return (
    <div className={`toolzite-shell${isEmbedded ? ' embed-mode' : ''}`}>
      {!isEmbedded && (
        <header className="utility-header">
          <div className="utility-brand">
            <a href="https://www.toolzite.com/" className="utility-brand-badge" aria-label="ToolZite home">
              TZ
            </a>
            <div>
              <p className="utility-brand-eyebrow">ToolZite</p>
              <h1 className="utility-brand-title">Document, image, and browser-side utility tools.</h1>
            </div>
          </div>
          <div className="utility-nav">
            <a href="https://www.toolzite.com/products">AI Tools</a>
            <a href="https://www.toolzite.com/code-tools/algorithms/two-sum">Code Tools</a>
            <a href="https://www.toolzite.com/ai-news">Resources</a>
            <span className="utility-nav-pill">PDF Tools</span>
          </div>
        </header>
      )}

      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="badge">ToolZite Utilities</div>
            <p className="brand-title">Every file workflow under the same ToolZite hood.</p>
            <p className="muted tiny">Each utility has its own direct URL and runs locally in your browser.</p>
          </div>
          <div className="control">
            <input
              type="text"
              placeholder="Search tools…"
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
            />
          </div>
          <div className="pill-row">
            {['all', 'pdf', 'image', 'code', 'text'].map((value) => (
              <button
                key={value}
                className={`pill ${category === value ? 'pill-active' : ''}`}
                onClick={() => setCategory(value as typeof category)}
              >
                <span className="pill-title">{value.toUpperCase()}</span>
              </button>
            ))}
          </div>
          <div className="tool-stack scrollable">
            {visibleTools.map((tool) => (
              <button
                key={tool.id}
                className={`tool ${tool.id === activeTool ? 'active' : ''}`}
                onClick={() => {
                  setActiveTool(tool.id)
                  resetMessages()
                }}
              >
                <div>
                  <p className="tool-label">{tool.label}</p>
                  <p className="muted tiny">{tool.tagline}</p>
                </div>
                <span>↗</span>
              </button>
            ))}
          </div>
        </aside>

        <main
          className={`workspace ${uploading ? 'is-uploading' : ''} ${uploadComplete ? 'upload-complete' : ''}`}
          onChangeCapture={onFileInputChangeCapture}
          style={workspaceStyle}
        >
          <header className="hero">
            <div>
              <p className="eyebrow">ToolZite active utility</p>
              <h1>{currentTool.label}</h1>
              <p className="muted">{currentTool.description}</p>
            </div>
            <div className="hero-badge">
              <span className="message-icon" aria-hidden>
                i
              </span>
              <p className="tiny">Direct route: {getToolPath(activeTool)}</p>
            </div>
          </header>

          {renderActiveTool()}

          <div className="status-bar">
            {error ? <p className="error">{error}</p> : <p className="muted">{status || 'Ready for your files.'}</p>}
            <div className="status-right">
              {(uploading || uploadComplete) && (
                <div className="upload-progress-wrap" role="status" aria-live="polite">
                  <p className="muted tiny">
                    {uploadComplete ? 'Upload complete' : `Uploading ${Math.round(uploadProgress)}%`}
                  </p>
                  <div className="upload-track" aria-hidden>
                    <span style={{ width: `${uploadProgress}%` }} />
                  </div>
                </div>
              )}
              {(isProcessing || uploading) && <span className="loader" aria-hidden />}
            </div>
          </div>
        </main>
      </div>

      {!isEmbedded && (
        <footer className="utility-footer">
          <span>ToolZite PDF and Utility Tools</span>
          <div className="utility-footer-links">
            <a href="https://www.toolzite.com/">ToolZite Home</a>
            <a href="https://www.toolzite.com/allcategory">All Categories</a>
            <a href={`https://www.toolzite.com/pdf-tools${getToolPath(activeTool)}`}>Share This Tool</a>
          </div>
        </footer>
      )}
    </div>
  )
}

export default App
