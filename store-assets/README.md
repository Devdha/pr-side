# PR Side Chrome Web Store Assets

## Screenshots

All screenshots are 1280x800 PNG files and use neutral demo pull-request data.

- English light: `screenshots/en/01-pr-groups-light.png`
- English dark: `screenshots/en/02-pr-groups-dark.png`
- Korean light: `screenshots/ko/01-pr-groups-light.png`
- Korean dark: `screenshots/ko/02-pr-groups-dark.png`

The screenshots show the extension's popup, authored and review-requested tab groups, and the local-processing disclosure. The browser workspace is explicitly labeled as a demo and contains no real account, repository, or pull-request information.

## Capture source

`capture/index.html` and `capture/capture.css` are the reproducible source for the screenshots. Serve the repository root and open:

```text
/store-assets/capture/index.html?lang=en&theme=light
/store-assets/capture/index.html?lang=en&theme=dark
/store-assets/capture/index.html?lang=ko&theme=light
/store-assets/capture/index.html?lang=ko&theme=dark
```

Capture each page at an exact 1280x800 viewport.
