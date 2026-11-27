# Fact-check golden set

These fixtures test the fact-check gate. They hold known bad and good article versions, the source records, and hero images that must pass or fail.

## The data is not in git

This repository is public. The folders `articles/`, `sources/` and `heroes/` are in `.gitignore`.
They hold article text with known false claims, journal abstracts and generated images.

Git holds only `manifest.json`, `golden-set.test.js` and this file.

The full set is in a local folder that git ignores:

    <main checkout>/tasks/factcheck-golden-set/

## Contents of the full set

- `articles/` : one JSON file for each article version. A bad version lists its defects and the exact quote for each.
- `sources/` : PubMed and PMC XML files. Two PubMed files are the wrongly cited papers.
- `heroes/` : six JPEG images. Three must fail the check and three must pass.
- `manifest.json` : the index, the defect classes and the coverage map.

## Run the test

From the repository root:

    node --test lib/factcheck/fixtures/golden-set.test.js

- If the data folders are next to the test, the test uses them.
- If they are not, each test is skipped and gives the reason.
- To use the local copy, set `GOLDEN_DIR` to that folder first. With `GOLDEN_DIR` set, missing data is a failure, not a skip.

A skipped run proves nothing. Before a fact-check change merges, run the test with the data.

## Deploy

`.vercelignore` excludes this folder. No runtime code may read it.
