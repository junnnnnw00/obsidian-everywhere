# Product Hunt launch automation

This directory keeps the editable Product Hunt copy separate from generated
assets. Update `launch.json`, then run:

```bash
npm run product-hunt:prepare
```

The command validates Product Hunt's field limits and creates
`product-hunt/dist/` containing:

- a 240×240 thumbnail;
- four 1270×760 gallery images;
- the complete six-function demo GIF;
- copy-ready submission text and JSON;
- SHA-256 checksums for the generated kit.

The **Product Hunt launch kit** GitHub Actions workflow runs the same command
and uploads the result as a private workflow artifact.

## What remains manual

Product Hunt does not expose public product-submission automation. A personal
account must create the product, add the maker, and choose **Create Draft** or
**Schedule Launch**. Scheduled launches can be set up to 30 days ahead. New
personal accounts may need to complete onboarding and wait one week before
posting.

Use the generated `submission.md` as the upload and copy/paste checklist. The
first comment asks for product feedback, never votes.

- [Product Hunt posting guide](https://help.producthunt.com/en/articles/479557-how-to-post-a-product)
- [Scheduling guide](https://help.producthunt.com/en/articles/2724119-how-to-schedule-a-post)
- [Posting access](https://help.producthunt.com/en/articles/481909-how-can-i-get-access-to-post)
