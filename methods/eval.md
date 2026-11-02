# Method: eval

Design and run a blinded experiment that compares variants of a prompt, skill, or model.

## Steps

1. Frame: name the variant under test and write a 3-6 criterion rubric for the judge only.
2. Set up a sanitized working dir per candidate; no words like eval, test, judge, rubric, or benchmark in anything a candidate sees.
3. Write one organic prompt, as a real user would type it.
4. Run N candidates in parallel, ideally on different model families.
5. Run one blinded judge from a different family; it sees outputs by sanitized label only.
6. Synthesize: scores, variance, and a recommendation.

## Principles

- Blinding is non-negotiable; never tell a candidate other candidates exist.
- `explain-the-number`: Report sample count and spread, not just a winner.

## Evidence

- Rubric, prompt, per-candidate scores, judge rationale, artifact paths.
