const { test } = require('node:test');
const assert = require('node:assert/strict');
const { imageFromBytes, imageLimit } = require('../dist/images');
test('image bytes determine MIME and enforce the size bound', () => {
  assert.equal(imageFromBytes('wrong.jpg', Buffer.from([137,80,78,71,13,10,26,10])).mime, 'image/png');
  assert.equal(imageFromBytes('a.jpg', Buffer.from([255,216,255])).mime, 'image/jpeg');
  for (const data of [Buffer.from('<svg/>'), Buffer.alloc(0), Buffer.alloc(imageLimit + 1)]) assert.throws(() => imageFromBytes('a.png', data));
});

const { imageFromDrop } = require('../dist/images');
test('webview drop validates encoded bytes and ignores claimed MIME', () => {
  const data = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
  assert.equal(imageFromDrop({ name: 'image.png', data, mime: 'image/jpeg' }).mime, 'image/png');
  for (const value of [null, {}, {name:'../a.png',data}, {name:'a.png',data:'???'}, {name:'a.png',data:'A'.repeat(Math.ceil(imageLimit/3)*4+4)}]) assert.throws(() => imageFromDrop(value));
  const large = Buffer.alloc(imageLimit); Buffer.from([137,80,78,71,13,10,26,10]).copy(large);
  assert.equal(imageFromDrop({name:'large.png',data:large.toString('base64')}).mime, 'image/png');
});
