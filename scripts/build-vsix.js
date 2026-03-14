const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const readmePath = path.join(__dirname, '..', 'README.md');
const backupPath = path.join(__dirname, '..', 'README.md.bak');

// 1. Read the original README
if (!fs.existsSync(readmePath)) {
    console.error('README.md not found!');
    process.exit(1);
}

const originalReadme = fs.readFileSync(readmePath, 'utf8');

// 2. Backup the README
fs.writeFileSync(backupPath, originalReadme);

try {
    console.log('Temporarily stripping SVG badges from README.md for VSCE packaging...');

    // 3. Strip lines containing SVG badges (specifically the pipeline and release ones)
    // VSCE will reject ANY image ending in .svg that isn't from a trusted domain.
    const strippedReadme = originalReadme.split('\n').filter(line => {
        return !line.includes('.svg') && !line.includes('pipeline status') && !line.includes('Latest Release');
    }).join('\n');

    fs.writeFileSync(readmePath, strippedReadme);

    // 4. Run vsce package
    console.log('Running vsce package...');
    execSync('npx @vscode/vsce package --baseContentUrl https://raw.githubusercontent.com/IcyHot09/opengrok-mcp-server/main --baseImagesUrl https://raw.githubusercontent.com/IcyHot09/opengrok-mcp-server/main', { stdio: 'inherit' });

    console.log('VSIX packaging completed successfully.');

} catch (error) {
    console.error('VSIX packaging failed:', error.message);
    process.exitCode = 1;
} finally {
    // 5. Restore the true README regardless of success or failure
    console.log('Restoring original README.md with SVG badges...');
    fs.writeFileSync(readmePath, originalReadme);

    if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
    }
}
