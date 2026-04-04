const fs = require('fs');
const light = fs.readFileSync('assets/fonts/Nunito-Light.woff2').toString('base64');
const regular = fs.readFileSync('assets/fonts/Nunito-Regular.woff2').toString('base64');
const code = `// Auto-generated - do not edit
const LIGHT = '${light}';
const REGULAR = '${regular}';

export function injectFonts() {
  const style = document.createElement('style');
  style.textContent = \`
    @font-face {
      font-family: 'Nunito';
      font-weight: 300;
      font-style: normal;
      font-display: swap;
      src: url(data:font/woff2;base64,\${LIGHT}) format('woff2');
    }
    @font-face {
      font-family: 'Nunito';
      font-weight: 400;
      font-style: normal;
      font-display: swap;
      src: url(data:font/woff2;base64,\${REGULAR}) format('woff2');
    }
  \`;
  document.head.appendChild(style);
}
`;
fs.writeFileSync('src/ui/fonts.js', code);
console.log('fonts.js generated (' + Math.round(code.length / 1024) + 'KB)');
