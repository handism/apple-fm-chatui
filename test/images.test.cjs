const { test } = require('node:test');
const assert = require('node:assert/strict');
const { imageFromBytes, imageLimit } = require('../dist/images');
test('image bytes determine MIME and enforce the size bound', () => {
  assert.equal(imageFromBytes('wrong.jpg', Buffer.from([137,80,78,71,13,10,26,10])).mime, 'image/png');
  assert.equal(imageFromBytes('a.jpg', Buffer.from([255,216,255])).mime, 'image/jpeg');
  for (const data of [Buffer.from('<svg/>'), Buffer.alloc(0), Buffer.alloc(imageLimit + 1)]) assert.throws(() => imageFromBytes('a.png', data));
});
