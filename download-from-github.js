const https = require('https');
const fs = require('fs');
const path = require('path');
const tar = require('tar');

const GITHUB_URL = 'https://github.com/Adrunkenronin/chess.com-boards-and-pieces/archive/master.tar.gz';
const TEMP_FILE = '/tmp/chess-assets.tar.gz';
const EXTRACT_PATH = '/tmp/chess-assets-extracted';
const BOARDS_DEST = path.join(__dirname, 'boards');
const PIECES_DEST = path.join(__dirname, 'pieces');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        return downloadFile(response.headers.location, filepath)
          .then(resolve)
          .catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  const files = fs.readdirSync(src);
  
  files.forEach(file => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    
    if (fs.lstatSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

async function main() {
  try {
    console.log('Downloading chess assets from GitHub...');
    await downloadFile(GITHUB_URL, TEMP_FILE);
    console.log('✓ Downloaded');
    
    console.log('Extracting archive...');
    ensureDir(EXTRACT_PATH);
    await tar.extract({
      file: TEMP_FILE,
      cwd: EXTRACT_PATH
    });
    console.log('✓ Extracted');
    
    // Find the extracted directory (it will be something like chess.com-boards-and-pieces-master)
    const extracted = fs.readdirSync(EXTRACT_PATH)[0];
    const sourceDir = path.join(EXTRACT_PATH, extracted);
    
    console.log(`Found extracted directory: ${extracted}`);
    
    // Copy boards
    const sourceBoardsDir = path.join(sourceDir, 'boards');
    if (fs.existsSync(sourceBoardsDir)) {
      console.log('Copying boards...');
      copyDirRecursive(sourceBoardsDir, BOARDS_DEST);
      console.log(`✓ Boards copied to ${BOARDS_DEST}`);
    }
    
    // Copy pieces
    const sourcePiecesDir = path.join(sourceDir, 'pieces');
    if (fs.existsSync(sourcePiecesDir)) {
      console.log('Copying pieces...');
      copyDirRecursive(sourcePiecesDir, PIECES_DEST);
      console.log(`✓ Pieces copied to ${PIECES_DEST}`);
    }
    
    // Cleanup
    fs.rmSync(TEMP_FILE, { force: true });
    fs.rmSync(EXTRACT_PATH, { recursive: true, force: true });
    
    console.log('\n✓ Complete! Board and piece files are now hosted locally.');
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
