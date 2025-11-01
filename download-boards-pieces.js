const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const boardPiecesData = require('./board-pieces-data.json');

const BOARDS_DIR = path.join(__dirname, 'boards');
const PIECES_DIR = path.join(__dirname, 'pieces');
const DOWNLOAD_SIZES = [75, 140, 200, 300, 600];
const PIECE_CODES = ['w', 'b'];
const PIECE_TYPES = ['k', 'q', 'r', 'b', 'n', 'p'];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filepath);
    
    protocol.get(url, (response) => {
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

async function downloadBoards() {
  console.log('Downloading board images...');
  const boards = boardPiecesData.boards;
  let downloaded = 0;
  let failed = 0;

  for (const [boardName, urlTemplate] of Object.entries(boards)) {
    const boardDir = path.join(BOARDS_DIR, boardName);
    ensureDir(boardDir);

    for (const size of DOWNLOAD_SIZES) {
      const url = urlTemplate.replace('{}', size).replace('https://', 'https://').replace('http://', 'http://');
      const filename = path.join(boardDir, `${size}.png`);

      if (fs.existsSync(filename)) {
        console.log(`✓ ${boardName}/${size}.png (already exists)`);
        continue;
      }

      try {
        console.log(`↓ Downloading ${boardName}/${size}.png...`);
        await downloadFile(url, filename);
        console.log(`✓ ${boardName}/${size}.png`);
        downloaded++;
      } catch (err) {
        console.error(`✗ Failed to download ${boardName}/${size}.png: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nBoard download complete: ${downloaded} downloaded, ${failed} failed\n`);
}

async function downloadPieces() {
  console.log('Downloading piece images...');
  const pieces = boardPiecesData.pieces;
  let downloaded = 0;
  let failed = 0;

  for (const [pieceName, urlTemplate] of Object.entries(pieces)) {
    const pieceDir = path.join(PIECES_DIR, pieceName);
    ensureDir(pieceDir);

    for (const color of PIECE_CODES) {
      const colorDir = path.join(pieceDir, color);
      ensureDir(colorDir);

      for (const type of PIECE_TYPES) {
        const url = urlTemplate.replace(/{}/g, (match) => {
          if (match === urlTemplate[0]) return color;
          return type;
        }).replace('https://', 'https://').replace('http://', 'http://');
        
        const filename = path.join(colorDir, `${type}.png`);

        if (fs.existsSync(filename)) {
          console.log(`✓ ${pieceName}/${color}/${type}.png (already exists)`);
          continue;
        }

        try {
          console.log(`↓ Downloading ${pieceName}/${color}/${type}.png...`);
          await downloadFile(url, filename);
          console.log(`✓ ${pieceName}/${color}/${type}.png`);
          downloaded++;
        } catch (err) {
          console.error(`✗ Failed to download ${pieceName}/${color}/${type}.png: ${err.message}`);
          failed++;
        }
      }
    }
  }

  console.log(`\nPiece download complete: ${downloaded} downloaded, ${failed} failed\n`);
}

async function main() {
  console.log('Setting up local board and piece images...\n');
  
  try {
    ensureDir(BOARDS_DIR);
    ensureDir(PIECES_DIR);
    
    await downloadBoards();
    await downloadPieces();
    
    console.log('✓ Setup complete! Board and piece images are now hosted locally.');
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }
}

main();
