import { generateStorageKey } from '../src/config/storage.js';

// Test different filename scenarios
const testCases = [
  'poojasahu.jpg',
  'model-photo.png', 
  'outfit-image.webp',
  'file-without-extension',
  'file.with.multiple.dots.jpg',
  'path/to/file/image.jpeg'
];

console.log('Testing storage key generation:');
console.log('================================');

testCases.forEach(filename => {
  const storageKey = generateStorageKey('uploads/model', filename, 'test-user-123');
  console.log(`Input: "${filename}"`);
  console.log(`Output: "${storageKey}"`);
  console.log('---');
});