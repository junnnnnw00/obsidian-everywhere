# Code Block Test

Below is a fenced code block containing wikilink-looking text that must NOT be parsed as a link:

```
[[Note A]]
![[Note A]]
```

Inline code must also be ignored: `[[Note A]]` is not a link here.

A real link outside of code still works: [[Note B]] is a genuine link.
