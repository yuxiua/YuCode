const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

const input = path.join(__dirname, '..', '代码Agent图标设计.jpeg')
const resourcesDir = path.join(__dirname, '..', 'resources')

if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true })

async function generateIcons() {
  // Check if input exists
  if (!fs.existsSync(input)) {
    console.log('Input image not found, creating fallback SVG icon')
    generateFallbackIcon()
    return
  }

  const image = sharp(input)
  const metadata = await image.metadata()
  console.log(`Input: ${metadata.width}x${metadata.height}, format: ${metadata.format}`)

  // Resize to 512x512 with rounded corners on dark background
  const base = await sharp(input)
    .resize(512, 512, { fit: 'cover', position: 'center' })
    // Add subtle dark background
    .composite([{
      input: Buffer.from(`<svg width="512" height="512"><rect width="512" height="512" rx="96" fill="#0f1117"/></svg>`),
      blend: 'over'
    }])
    // Actually, let's just do a simple resize with rounded corners
    .toBuffer()

  // For the app icon, we want it on a transparent background with rounded corners
  const icon512 = await sharp(input)
    .resize(512, 512, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer()

  // Write various sizes
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
  for (const size of sizes) {
    await sharp(input)
      .resize(size, size, { fit: 'cover', position: 'center' })
      .png()
      .toFile(path.join(resourcesDir, `icon-${size}.png`))
    console.log(`Generated icon-${size}.png`)
  }

  // Create .ico file (Windows)
  // ICO format supports multiple sizes
  const icoBuffers = []
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const png = await sharp(input)
      .resize(size, size, { fit: 'cover', position: 'center' })
      .png()
      .toBuffer()
    icoBuffers.push({ size, data: png })
  }

  // Build ICO file
  const ico = buildIco(icoBuffers)
  fs.writeFileSync(path.join(resourcesDir, 'icon.ico'), ico)
  console.log('Generated icon.ico')

  // Main icon for electron
  await sharp(input)
    .resize(256, 256, { fit: 'cover', position: 'center' })
    .png()
    .toFile(path.join(resourcesDir, 'icon.png'))
  console.log('Generated icon.png (main)')

  console.log('\nAll icons generated successfully!')
}

function buildIco(entries) {
  const headerSize = 6
  const dirEntrySize = 16
  const dataOffset = headerSize + entries.length * dirEntrySize

  // Header: reserved(2) + type(2)=1 + count(2)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: ICO
  header.writeUInt16LE(entries.length, 4) // count

  // Directory entries
  let dir = Buffer.alloc(entries.length * dirEntrySize)
  let offset = dataOffset
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const w = entry.size >= 256 ? 0 : entry.size
    const h = entry.size >= 256 ? 0 : entry.size
    dir.writeUInt8(w, i * 16) // width
    dir.writeUInt8(h, i * 16 + 1) // height
    dir.writeUInt8(0, i * 16 + 2) // color count
    dir.writeUInt8(0, i * 16 + 3) // reserved
    dir.writeUInt16LE(1, i * 16 + 4) // color planes
    dir.writeUInt16LE(32, i * 16 + 6) // bit depth
    dir.writeUInt32LE(entry.data.length, i * 16 + 8) // data size
    dir.writeUInt32LE(offset, i * 16 + 12) // data offset
    offset += entry.data.length
  }

  // Concatenate all
  const result = Buffer.concat([header, dir, ...entries.map(e => e.data)])
  return result
}

function generateFallbackIcon() {
  // Create a simple SVG-based icon as fallback
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0f1117"/>
  <rect x="16" y="16" width="480" height="480" rx="80" fill="none" stroke="#6366f1" stroke-width="4" opacity="0.3"/>
  <text x="256" y="320" font-family="Arial, sans-serif" font-size="280" font-weight="bold" fill="#6366f1" text-anchor="middle">Y</text>
  <text x="256" y="420" font-family="Arial, sans-serif" font-size="48" fill="#a5b4fc" text-anchor="middle">CODE</text>
</svg>`
  sharp(Buffer.from(svg)).png().toFile(path.join(resourcesDir, 'icon.png'))
    .then(() => {
      // Generate all sizes
      return Promise.all([16, 24, 32, 48, 64, 128, 256, 512].map(s =>
        sharp(Buffer.from(svg)).resize(s, s).png().toFile(path.join(resourcesDir, `icon-${s}.png`))
      ))
    })
    .then(() => {
      // Simple ICO (just the 256px PNG wrapped)
      const png = fs.readFileSync(path.join(resourcesDir, 'icon-256.png'))
      const header = Buffer.alloc(6)
      header.writeUInt16LE(0, 0)
      header.writeUInt16LE(1, 2)
      header.writeUInt16LE(1, 4)
      const dir = Buffer.alloc(16)
      dir.writeUInt8(0, 0) // width (0 = 256)
      dir.writeUInt8(0, 1) // height (0 = 256)
      dir.writeUInt16LE(1, 4) // planes
      dir.writeUInt16LE(32, 6) // bpp
      dir.writeUInt32LE(png.length, 8) // size
      dir.writeUInt32LE(22, 12) // offset
      fs.writeFileSync(path.join(resourcesDir, 'icon.ico'), Buffer.concat([header, dir, png]))
      console.log('Fallback icons generated successfully!')
    })
}

generateIcons().catch(console.error)
