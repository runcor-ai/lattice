import { describe, it, expect } from 'vitest';

import { PersonaBundleRegistry, composePersona } from './index.js';

describe('Persona bundle composition (Item 11)', () => {
  function reg() {
    return new PersonaBundleRegistry()
      .register('software-engineer', 'I am a software engineer. I value correctness and tests.')
      .register('applicant-facing', 'I communicate plainly and never invent facts for applicants.');
  }

  it('composes bundles in declared order', () => {
    const c = composePersona(reg(), ['software-engineer', 'applicant-facing']);
    expect(c.composed.indexOf('software engineer')).toBeLessThan(c.composed.indexOf('applicant'));
    expect(c.parts.map((p) => p.name)).toEqual(['software-engineer', 'applicant-facing']);
    expect(c.missing).toEqual([]);
  });

  it('order matters — reversing changes the assembly', () => {
    const a = composePersona(reg(), ['software-engineer', 'applicant-facing']).composed;
    const b = composePersona(reg(), ['applicant-facing', 'software-engineer']).composed;
    expect(a).not.toBe(b);
  });

  it('appends the inline seed LAST so it can refine the shared bundles', () => {
    const c = composePersona(reg(), ['software-engineer'], { inline: 'Also: I am terse.' });
    expect(c.composed.endsWith('Also: I am terse.')).toBe(true);
    expect(c.parts[c.parts.length - 1]!.name).toBe('(inline)');
  });

  it('surfaces missing bundle names rather than dropping them silently', () => {
    const c = composePersona(reg(), ['software-engineer', 'no-such-bundle']);
    expect(c.missing).toEqual(['no-such-bundle']);
    expect(c.parts.map((p) => p.name)).toEqual(['software-engineer']);
  });

  it('legacy: no bundles + inline only reproduces the single-document persona', () => {
    const c = composePersona(new PersonaBundleRegistry(), [], { inline: 'I am a lone lattice.' });
    expect(c.composed).toBe('I am a lone lattice.');
    expect(c.parts).toEqual([{ name: '(inline)', chars: 'I am a lone lattice.'.length }]);
  });

  it('a central edit propagates to the next composition (same registry, new compose)', () => {
    const r = new PersonaBundleRegistry().register('p', 'v1');
    expect(composePersona(r, ['p']).composed).toBe('v1');
    r.register('p', 'v2-edited');
    expect(composePersona(r, ['p']).composed).toBe('v2-edited');
  });
});
