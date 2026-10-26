import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const html = (text: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Markdown, { text })));
const items = (markup: string) => [...markup.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

describe('Markdown lists', () => {
  it('keeps the words of numbered points written with a tab after the number', () => {
    expect(items(html('Please check:\n1.\tReason for disconnection\n2.\tDisconnection timeline'))).toEqual(['Reason for disconnection', 'Disconnection timeline']);
  });
  it('keeps the words of a numbered point whose text is on the next line', () => {
    expect(items(html('1.\n\tReason for disconnection: planned maintenance?\n2.\n\tLogs and analysis'))).toEqual(['Reason for disconnection: planned maintenance?', 'Logs and analysis']);
  });
  it('still reads ordinary lists', () => {
    expect(items(html('- one\n- two'))).toEqual(['one', 'two']);
    expect(items(html('1. one\n2. two'))).toEqual(['one', 'two']);
  });
});
