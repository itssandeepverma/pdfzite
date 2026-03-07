import codeDiff from './codeDiff'
import compress from './compress'
import countText from './countText'
import imageBorder from './imageBorder'
import imageCrop from './imageCrop'
import imageDob from './imageDob'
import imageReduce from './imageReduce'
import imageResize from './imageResize'
import imageRotate from './imageRotate'
import imageSignature from './imageSignature'
import jpgToPdf from './jpgToPdf'
import merge from './merge'
import organizePdf from './organizePdf'
import pageNumbers from './pageNumbers'
import pdfToJpg from './pdfToJpg'
import pdfToWord from './pdfToWord'
import rotatePdf from './rotatePdf'
import split from './split'

export type { ToolCategory, ToolInfo, ToolKey } from './types'

export const tools = [
  compress,
  merge,
  split,
  pdfToJpg,
  jpgToPdf,
  organizePdf,
  rotatePdf,
  pageNumbers,
  pdfToWord,
  imageReduce,
  imageResize,
  imageCrop,
  imageRotate,
  imageSignature,
  imageDob,
  imageBorder,
  codeDiff,
  countText,
]
