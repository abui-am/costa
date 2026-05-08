/** Allowed uploads: JPEG / PNG / WebP / GIF / HEIF (HEIC). HEIF is rasterized server-side before GPT vision. */

const KNOWN_FROM_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heifs': 'image/heic',
  '.heif': 'image/heif',
}

export function mimeFromFilename(filename: string): string | undefined {
  const i = filename.lastIndexOf('.')
  if (i < 0) {
    return undefined
  }
  const ext = filename.slice(i).toLowerCase()
  return KNOWN_FROM_EXT[ext]
}

/** Sniff real format (Swagger / WhatsApp sometimes ship wrong MIME or no filename). */
export function mimeFromMagicBytes(buffer: Buffer | undefined): string | undefined {
  if (!buffer?.length || buffer.length < 12) {
    return undefined
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  // GIF87a / GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif'
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  // ISO BMFF ftyp @ offset 4 — HEIF/HEIC-ish brands only
  if (
    buffer.length >= 16 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const brand = buffer.subarray(8, 12).toString('ascii').trim().toLowerCase()
    if (
      brand === 'heic' ||
      brand === 'heix' ||
      brand === 'heim' ||
      brand === 'heis' ||
      brand === 'hevc' ||
      brand === 'hevx'
    ) {
      return 'image/heic'
    }
    if (brand === 'mif1' || brand === 'msf1') {
      return 'image/heif'
    }
  }
  return undefined
}

/** Whether multer post-parse gate should accept (MIME/name and/or magic bytes). */
export function passesBillImageUpload(file: {
  mimetype?: string
  originalname?: string
  buffer?: Buffer
}): boolean {
  if (!file.buffer?.length) {
    return false
  }
  if (mimeFromMagicBytes(file.buffer)) {
    return true
  }

  const base = (file.mimetype ?? '').split(';')[0].trim().toLowerCase()
  const name = file.originalname ?? ''

  // Common declarative MIME (incl. jfif, x‑png quirks)
  if (
    /^image\/(jpeg|jpg|jfif|pjpeg|png|webp|gif|x-png|heic|heif|heif-sequence)$/i.test(
      base,
    )
  ) {
    return true
  }

  if (
    base === 'application/octet-stream' ||
    base === '' ||
    base === 'binary/octet-stream'
  ) {
    return mimeFromFilename(name) !== undefined
  }

  return false
}

/** Stable MIME for `data:image/...` + OpenAI vision. Optional buffer disambiguates bad clients. */
export function normalizedBillImageDataUrlMime(
  rawMime: string | undefined,
  filename: string,
  buffer?: Buffer | undefined,
): string {
  const base = (rawMime ?? '').split(';')[0].trim().toLowerCase()

  if (
    base === 'image/jpg' ||
    base === 'image/pjpeg' ||
    base === 'image/jpeg' ||
    base === 'image/jfif'
  ) {
    return 'image/jpeg'
  }
  if (base === 'image/png' || base === 'image/x-png') {
    return 'image/png'
  }
  if (base === 'image/webp') {
    return 'image/webp'
  }
  if (base === 'image/gif') {
    return 'image/gif'
  }
  if (base === 'image/heic') {
    return 'image/heic'
  }
  if (base === 'image/heif' || base === 'image/heif-sequence') {
    return 'image/heif'
  }

  const fromName = mimeFromFilename(filename)
  if (fromName) {
    return normalizedBillImageDataUrlMime(fromName, '', buffer)
  }

  const fromMagic = buffer?.length ? mimeFromMagicBytes(buffer) : undefined
  if (fromMagic) {
    return fromMagic
  }

  return 'image/jpeg'
}
