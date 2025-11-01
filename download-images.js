const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const boardPiecesData = require('./board-pieces-data.json');

const BOARDS_DIR = path.join(__dirname, 'boards');
const PIECES_DIR = path.join(__dirname, 'pieces');
const BOARD_SIZES = [75, 140, 200, 300, 600];
const PIECE_COLORS = ['w', 'b'];
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
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        return downloadFile(response.headers.location, filepath)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(filepath, () => {});
        reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

async function downloadBoards() {
  console.log('Downloading board images from chess.com...\n');
  const boards = boardPiecesData.boards;
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  for (const [boardName, urlTemplate] of Object.entries(boards)) {
    const boardDir = path.join(BOARDS_DIR, boardName);
    ensureDir(boardDir);

    for (const size of BOARD_SIZES) {
      const url = urlTemplate.replace('{}', size);
      const filename = path.join(boardDir, `${size}.png`);

      if (fs.existsSync(filename) && fs.statSync(filename).size > 0) {
        skipped++;
        continue;
      }

      try {
        process.stdout.write(`Downloading ${boardName}/${size}.png...`);
        await downloadFile(url, filename);
        const stats = fs.statSync(filename);
        console.log(` ✓ (${(stats.size / 1024).toFixed(1)}KB)`);
        downloaded++;
      } catch (err) {
        console.log(` ✗ (${err.message})`);
        fs.unlink(filename, () => {});
        failed++;
      }
    }
  }

  console.log(`\nBoards: ${downloaded} downloaded, ${failed} failed, ${skipped} skipped\n`);
  return { downloaded, failed };
}

async function downloadPieces() {
  console.log('Downloading piece images from chess.com...\n');
  const pieces = boardPiecesData.pieces;
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  for (const [pieceName, urlTemplate] of Object.entries(pieces)) {
    const pieceDir = path.join(PIECES_DIR, pieceName);
    ensureDir(pieceDir);

    for (const color of PIECE_COLORS) {
      const colorDir = path.join(pieceDir, color);
      ensureDir(colorDir);

      for (const type of PIECE_TYPES) {
        let url = urlTemplate;
        let braceCount = 0;
        url = url.replace(/{}/g, () => {
          braceCount++;
          return braceCount === 1 ? color : type;
        });
        
        const filename = path.join(colorDir, `${type}.png`);

        if (fs.existsSync(filename) && fs.statSync(filename).size > 0) {
          skipped++;
          continue;
        }

        try {
          process.stdout.write(`Downloading ${pieceName}/${color}/${type}.png...`);
          await downloadFile(url, filename);
          const stats = fs.statSync(filename);
          console.log(` ✓ (${(stats.size / 1024).toFixed(1)}KB)`);
          downloaded++;
        } catch (err) {
          console.log(` ✗ (${err.message})`);
          fs.unlink(filename, () => {});
          failed++;
        }
      }
    }
  }

  console.log(`\nPieces: ${downloaded} downloaded, ${failed} failed, ${skipped} skipped\n`);
  return { downloaded, failed };
}

async function main() {
  console.log('='.repeat(60));
  console.log('Chess.com Boards and Pieces Image Downloader');
  console.log('='.repeat(60) + '\n');
  
  try {
    const boardStats = await downloadBoards();
    const pieceStats = await downloadPieces();
    
    const totalDownloaded = boardStats.downloaded + pieceStats.downloaded;
    const totalFailed = boardStats.failed + pieceStats.failed;
    
    console.log('='.repeat(60));
    console.log(`Total: ${totalDownloaded} downloaded, ${totalFailed} failed`);
    
    if (totalFailed === 0) {
      console.log('✓ All images downloaded successfully!');
    } else if (totalDownloaded > 0) {
      console.log('⚠ Some downloads failed, but many succeeded.');
    } else {
      console.log('✗ All downloads failed.');
    }
    
    console.log('='.repeat(60));
    
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
