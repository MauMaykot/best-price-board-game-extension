import assert from 'node:assert/strict';
import test from 'node:test';
import { diceFaces } from '../panel/sprites.js';

test('até 6 turnos, um dado mostra o turno', () => {
  assert.deepEqual(diceFaces(1), [1]);
  assert.deepEqual(diceFaces(5), [5]);
  assert.deepEqual(diceFaces(6), [6]);
});

test('passando de 6, entra outro dado', () => {
  assert.deepEqual(diceFaces(7), [6, 1]);
  assert.deepEqual(diceFaces(12), [6, 6]);
  assert.deepEqual(diceFaces(13), [6, 6, 1]);
  assert.deepEqual(diceFaces(18), [6, 6, 6]);
});

test('a soma das faces é sempre o turno', () => {
  for (let turn = 1; turn <= 60; turn += 1) {
    assert.equal(diceFaces(turn).reduce((sum, face) => sum + face, 0), turn);
  }
});

test('sem turno jogado não há dado', () => {
  assert.deepEqual(diceFaces(0), []);
});
