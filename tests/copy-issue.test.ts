import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issueKeyAndSummary } from '../src/renderer/copy-issue';

describe('issue key and summary clipboard text', () => {
  it('keeps a one-line summary unchanged', () => {
    assert.equal(
      issueKeyAndSummary({ key: 'CAN-100', summary: 'Keep  two spaces' }),
      'CAN-100 Keep  two spaces',
    );
  });

  it('turns line breaks into spaces and trims the summary edges', () => {
    assert.equal(
      issueKeyAndSummary({
        key: 'CAN-100',
        summary: '  First line\r\n  second line\nthird line  ',
      }),
      'CAN-100 First line second line third line',
    );
  });
});
