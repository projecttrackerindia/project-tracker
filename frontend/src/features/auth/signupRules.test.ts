import { describe, expect, it } from 'vitest';
import { emailProblem, isDisposableDomain, nameProblem, organizationProblem } from './signupRules';

describe('sign-up name rule', () => {
  it.each(['Asha Rao', "Sinéad O'Brien", 'Jean-Luc Picard', 'Al', 'अनन्या शर्मा', 'Ravi  Kumar '])('accepts a real name: %s', (name) => {
    expect(nameProblem(name)).toBeNull();
  });
  it.each([
    ['', 'Enter your name.'],
    ['A', 'Enter your name (2 to 60 characters).'],
    ['x'.repeat(61), 'Enter your name (2 to 60 characters).'],
    ['Agent 007', 'A name cannot contain numbers.'],
    ['Visit www.cheap-deals.example', 'A name cannot contain a web or email address.'],
    ['Buy now http://spam', 'A name cannot contain a web or email address.'],
    ['Ravi 😀😀', 'Use letters, spaces, apostrophes and hyphens only.'],
    ['<script>', 'Use letters, spaces, apostrophes and hyphens only.'],
    ['-Ravi', 'Use letters, spaces, apostrophes and hyphens only.'],
    ['Aaaaa Bbbb', 'That does not look like a real name.'],
  ])('refuses %j', (name, message) => {
    expect(nameProblem(name)).toBe(message);
  });
});

describe('sign-up email rule', () => {
  it.each(['asha@fivestar.in', 'first.last+tag@mail.example.co.in', 'x@xn--h2brj9c.xn--h2brj9c'])('accepts %s', (email) => {
    expect(emailProblem(email)).toBeNull();
  });
  it.each(['plain', 'a@b', 'a@@b.com', 'a@b.c', '.a@b.com', 'a..b@b.com', 'a@[127.0.0.1]', 'a@-b.com', `${'x'.repeat(65)}@b.com`])('refuses %s', (email) => {
    expect(emailProblem(email)).toBe('Enter a valid email address.');
  });
  it('refuses disposable inboxes, subdomains included', () => {
    expect(emailProblem('someone@mailinator.com')).toMatch(/disposable/);
    expect(isDisposableDomain('inbox.yopmail.com')).toBe(true);
    expect(isDisposableDomain('fivestar.in')).toBe(false);
  });
});

describe('sign-up organisation rule', () => {
  it.each(['Five Star Business Finance Ltd.', 'R&D (India) Pvt Ltd', 'Studio 9'])('accepts %s', (org) => expect(organizationProblem(org)).toBeNull());
  it('refuses links, symbols, too few letters and mashed keys', () => {
    expect(organizationProblem('best-loans.com')).toMatch(/web or email/);
    expect(organizationProblem('Acme <b>')).toMatch(/only/);
    expect(organizationProblem('12345')).toMatch(/two letters/);
    expect(organizationProblem('Zzzzzz Corp')).toMatch(/real organisation/);
    expect(organizationProblem(' ')).toMatch(/2 to 100/);
  });
});
