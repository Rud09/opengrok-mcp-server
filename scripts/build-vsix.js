const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const readmePath = path.join(__dirname, '..', 'README.md');
const backupPath = path.join(__dirname, '..', 'README.md.bak');
const pkgPath = path.join(__dirname, '..', 'package.json');

// 1. Read the original README
if (!fs.existsSync(readmePath)) {
    console.error('README.md not found!');
    process.exit(1);
}

const originalReadme = fs.readFileSync(readmePath, 'utf8');
const originalPkg = fs.readFileSync(pkgPath, 'utf8');

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

    // 3b. Temporarily remove "files" field — vsce 3.x errors if both .vscodeignore
    // AND "files" are present. "files" is for npm publish only.
    const pkgJson = JSON.parse(originalPkg);
    if (pkgJson.files) {
        const pkgCopy = Object.assign({}, pkgJson);
        delete pkgCopy.files;
        fs.writeFileSync(pkgPath, JSON.stringify(pkgCopy, null, 2) + '\n');
    }

    // 4. Run vsce package
    console.log('Running vsce package...');
    execSync('npx @vscode/vsce package --baseContentUrl https://raw.githubusercontent.com/IcyHot09/opengrok-mcp-server/main --baseImagesUrl https://raw.githubusercontent.com/IcyHot09/opengrok-mcp-server/main', { stdio: 'inherit' });

    console.log('VSIX packaging completed successfully.');

} catch (error) {
    console.error('VSIX packaging failed:', error.message);
    process.exitCode = 1;
} finally {
    // 5. Restore README and package.json regardless of success or failure
    console.log('Restoring original README.md with SVG badges...');
    fs.writeFileSync(readmePath, originalReadme);
    fs.writeFileSync(pkgPath, originalPkg);

    if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
    }
}
