import { describe, expect, it } from 'vitest';
import { formatToolInput } from './toolInputDisplay';

describe('formatToolInput with malformed model arguments', () => {
  // A provider can emit an argument whose JSON type contradicts the tool schema
  // (e.g. a bracket lost during argument assembly turns an array into a string).
  // The tool rejects it at execution; the transcript must still render.
  it('renders keyword_search when search_terms is a string instead of an array', () => {
    expect(() =>
      formatToolInput('keyword_search', {
        query: 'license agreement flow',
        search_terms: 'license_agreement", "licence", "upload"]',
      })
    ).not.toThrow();

    expect(
      formatToolInput('keyword_search', {
        query: 'license agreement flow',
        search_terms: 'license_agreement", "licence", "upload"]',
      })
    ).toEqual({ display: 'license agreement flow', isMultiline: false });
  });

  it('still formats keyword_search terms when the array is well-formed', () => {
    expect(
      formatToolInput('keyword_search', { query: 'q', search_terms: ['a', 'b', 'c', 'd'] })
    ).toEqual({ display: '"q" [a, b, c...]', isMultiline: false });
  });

  it.each([
    ['tmux', { args: 'kill-session' }],
    ['patch', { path: 'a.rs', patches: 'modify' }],
    ['spawn_agents', { tasks: 'one task' }],
    ['ask_user_question', { questions: 'pick one' }],
    ['ask_user_question', { questions: [{ question: 'pick', options: 'a' }] }],
    ['browser_key_press', { key: 'Enter', modifiers: 'Shift' }],
  ])('renders %s when an array-typed field arrives as a string', (name, input) => {
    const result = formatToolInput(name, input as Record<string, unknown>);
    expect(typeof result.display).toBe('string');
  });
});
