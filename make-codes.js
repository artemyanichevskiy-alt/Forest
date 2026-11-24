// Генератор кодов доступа к визуалам. Запуск: node make-codes.js 10
// Коды выдавай покупателям, а хэши вставь в core.js в массив VISUALS_CODE_HASHES.
const crypto = require('crypto'), alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', n = +process.argv[2] || 10;
const codes = [], hashes = [];
for (let i = 0; i < n; i++) {
  let raw = ''; for (let k = 0; k < 12; k++) raw += alpha[crypto.randomInt(alpha.length)];
  codes.push(raw.match(/.{4}/g).join('-')); hashes.push(crypto.createHash('sha256').update(raw).digest('hex'));
}
console.log('КОДЫ (храни в секрете):\n' + codes.join('\n') + '\n\nХЭШИ для core.js:\n' + hashes.map(h => "  '" + h + "'").join(',\n'));
