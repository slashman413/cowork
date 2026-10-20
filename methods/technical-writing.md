# Method: technical writing (docs, READMEs, release notes)

Use for docs and READMEs. Source: pstack technical-writing @0c3333f.

## Steps

1. Pick one mode per doc: tutorial, how-to, reference, or explanation. Split mixed docs and link them.
2. Write to "you", present tense, active voice. Instructions are commands: "Run `npm test`."
3. Put the condition before the step: "To reset, run X."
4. One thought per sentence. Split steps over 20 words.
5. Use the real file, flag, and command names in code font.
6. Headings say the point, in sentence case. Number sequences, bullet the rest.
7. Apply the unslop rules in `methods/content.md`.

## Principles

- Cut every word that does no work. Use the short everyday word.
- Be specific: "a column rename fails the build", not "changes can cause issues".

## Evidence

- Every command in the doc was run, or is marked untested.
- Every count or path claim is true at the commit that lands it.
