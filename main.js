// main.js
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron')
const { createWorker } = require('tesseract.js')
const screenshot = require('screenshot-desktop')
const Jimp = require('jimp')
const path = require('path')

let overlayWindow = null
let popupWindow = null
let ocrWorker = null
let autoCloseTimer = null
let cachedScreenshot = null  // screenshot-г урьдчилан авна

// OCR Worker
async function initOCR() {
  ocrWorker = await createWorker('eng+jpn+kor', 1, { logger: () => {} })
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
  })
  console.log('[OCR] Ready: EN + JP + KR')
}

// Google Translate
async function googleTranslate(text, targetLang = 'mn') {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&dt=ld&dj=1&q=${encodeURIComponent(text)}`
  const res = await fetch(url)
  const data = await res.json()
  let translated = ''
  if (data.sentences) {
    translated = data.sentences.filter(s => s.trans).map(s => s.trans).join('')
  } else if (data[0]) {
    translated = data[0].map(item => item[0]).filter(Boolean).join('')
  }
  const detectedLang = data.src || data[2] || 'auto'
  return { translated, detectedLang }
}

// MyMemory
async function myMemoryTranslate(text, sourceLang, targetLang = 'mn') {
  const langPair = sourceLang !== 'auto' ? `${sourceLang}|${targetLang}` : `en|${targetLang}`
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`
  const res = await fetch(url)
  const data = await res.json()
  if (data.responseStatus === 200 && data.responseData?.translatedText) {
    return data.responseData.translatedText
  }
  return null
}

// Smart translate
async function translateText(text, targetLang = 'mn') {
  const googleResult = await googleTranslate(text, targetLang)
  if (text.length < 100) {
    try {
      const myMemoryResult = await myMemoryTranslate(text, googleResult.detectedLang, targetLang)
      if (myMemoryResult && myMemoryResult !== text && myMemoryResult.length > googleResult.translated.length * 0.8) {
        console.log('[Translate] MyMemory used')
        return { translated: myMemoryResult, detectedLang: googleResult.detectedLang }
      }
    } catch (e) {}
  }
  console.log('[Translate] Google used, lang:', googleResult.detectedLang)
  return googleResult
}

// ─── Overlay: нээхэд screenshot урьдчилан авна ────────────────────────────
function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
    overlayWindow = null
    cachedScreenshot = null
    return
  }

  const { width, height } = screen.getPrimaryDisplay().bounds

  // Overlay нээхээс өмнө screenshot авна (арын дэлгэц цэвэр байна)
  screenshot({ format: 'png' }).then(buf => {
    cachedScreenshot = buf
    console.log('[Screenshot] Cached before overlay')
  }).catch(e => console.log('[Screenshot] Cache failed:', e.message))

  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })
  overlayWindow.setIgnoreMouseEvents(false)
  overlayWindow.loadFile('overlay.html')
  overlayWindow.setFullScreen(true)
  overlayWindow.on('closed', () => { overlayWindow = null })
}

// Auto close timer
function startAutoClose(ms = 2500) {
  clearTimeout(autoCloseTimer)
  autoCloseTimer = setTimeout(() => {
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close()
  }, ms)
}

// Loading popup
function createLoadingPopup(x, y) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close()
    popupWindow = null
  }
  clearTimeout(autoCloseTimer)

  const { width, height } = screen.getPrimaryDisplay().bounds
  popupWindow = new BrowserWindow({
    width: 380, height: 300,
    x: Math.min(x + 10, width - 390),
    y: Math.min(y, height - 310),
    frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, transparent: false, movable: true,
    backgroundColor: '#1e1b4b', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })
  popupWindow.loadFile('popup.html')
  popupWindow.webContents.once('did-finish-load', () => {
    if (!popupWindow || popupWindow.isDestroyed()) return
    popupWindow.show()
    popupWindow.webContents.send('show-loading')
  })
  popupWindow.on('closed', () => { popupWindow = null; clearTimeout(autoCloseTimer) })
}

// ─── Pipeline: cached screenshot ашиглана ────────────────────────────────
async function processSelection(x, y, w, h) {
  try {
    // Cached screenshot ашиглана (overlay + popup байхгүй үеийн зураг)
    const imgBuffer = cachedScreenshot || await screenshot({ format: 'png' })
    cachedScreenshot = null

    const image = await Jimp.read(imgBuffer)

    const { width: sw, height: sh } = screen.getPrimaryDisplay().bounds
    const scaleX = image.bitmap.width / sw
    const scaleY = image.bitmap.height / sh

    const cx = Math.round(x * scaleX)
    const cy = Math.round(y * scaleY)
    const cw = Math.max(1, Math.round(w * scaleX))
    const ch = Math.max(1, Math.round(h * scaleY))

    const cropped = image.clone().crop(cx, cy, cw, ch)
    cropped.scale(2).greyscale().contrast(0.5)
    cropped.convolute([[-1,-1,-1],[-1,9,-1],[-1,-1,-1]])

    const cropBuffer = await cropped.getBufferAsync('image/png')

    const { data: { text, confidence } } = await ocrWorker.recognize(cropBuffer)
    const cleanText = text.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ')
    const conf = Math.round(confidence)
    console.log(`[OCR] ${conf}% | "${cleanText}"`)

    const resultData = cleanText && cleanText.length >= 2
      ? await (async () => {
          const { translated, detectedLang } = await translateText(cleanText)
          return {
            original: cleanText.length > 120 ? cleanText.substring(0, 120) + '...' : cleanText,
            translated, lang: detectedLang, confidence: conf
          }
        })()
      : {
          original: '(текст олдсонгүй)',
          translated: 'OCR текст олж чадсангүй.\nИлүү тод хэсэг сонгоно уу.',
          lang: '?', confidence: 0
        }

    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('show-result', resultData)
      startAutoClose(2500)
    }

  } catch (err) {
    console.error('[Error]', err.message)
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('show-result', {
        original: 'Алдаа', translated: err.message, lang: '!'
      })
      startAutoClose(2500)
    }
  }
}

// IPC
ipcMain.on('selection-done', (event, { x, y, w, h }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
    overlayWindow = null
  }
  createLoadingPopup(x, y)
  setTimeout(() => processSelection(x, y, w, h), 150)
})

ipcMain.on('cancel-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
    overlayWindow = null
  }
  cachedScreenshot = null
})

ipcMain.on('close-popup', () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close()
    popupWindow = null
  }
})

ipcMain.on('popup-hover', () => clearTimeout(autoCloseTimer))
ipcMain.on('popup-leave', () => startAutoClose(2500))

// App ready
app.whenReady().then(async () => {
  await initOCR()
  const ok = globalShortcut.register('Alt+D', () => createOverlay())
  console.log('[Shortcut] Alt+D registered:', ok)
  if (!ok) {
    const ok2 = globalShortcut.register('Alt+T', () => createOverlay())
    console.log('[Shortcut] Alt+T fallback:', ok2)
  }
  console.log('[App] Ready! Press Alt+D to start.')
})

app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  if (ocrWorker) await ocrWorker.terminate()
})

app.on('window-all-closed', (e) => e.preventDefault())