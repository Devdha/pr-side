# PR Side Privacy Policy

Effective date: August 3, 2026

Last updated: August 3, 2026

PR Side is an unofficial browser extension that organizes GitHub pull requests into Chrome tab groups. Its single purpose is to organize pull requests authored by the signed-in user and pull requests awaiting that user's review.

## Information PR Side processes

PR Side processes only the information needed to provide this purpose:

- GitHub pull-request titles, URLs, repository names, pull-request numbers, and recent-activity timestamps returned by the signed-in user's authored and review-requested pull-request pages;
- the URLs and titles of open GitHub pull-request tabs, so PR Side can avoid duplicates and maintain the correct tab groups;
- whether the existing GitHub browser session is signed in or signed out; and
- user-selected settings, such as grouping mode, synchronization interval, and recent-activity range.

PR Side relies on the GitHub session already managed by the browser. It does not read or store GitHub passwords or authentication-cookie values.

## How information is used

GitHub pull-request information is processed in the user's browser only to create, update, and remove Chrome tabs and tab groups requested by the user. PR Side does not use this information for analytics, advertising, profiling, credit decisions, or any unrelated purpose.

## Storage and retention

PR Side stores the following extension state:

- user-selected settings in `chrome.storage.sync`; Chrome may synchronize these settings between browsers where the user has enabled Chrome Sync; and
- the last synchronization status, pull-request counts, and Chrome tab-group identifiers in `chrome.storage.local` on the user's device.

PR Side does not store pull-request titles, URLs, repository names, or page contents in `chrome.storage` or on a developer-operated server.

Users can remove extension settings and local state by uninstalling PR Side or clearing the extension's data in Chrome. Synced settings can also be managed through the user's Chrome Sync settings.

## Network communication and sharing

PR Side sends only the HTTPS requests necessary to retrieve pull-request pages from `https://github.com`. Those requests use the browser's existing GitHub session and are subject to GitHub's privacy practices.

PR Side has no developer-operated application server. It does not transmit GitHub pull-request information to PR Side's developer, advertising networks, analytics providers, data brokers, or other third parties. It does not sell user data.

Chrome may synchronize non-content settings stored through `chrome.storage.sync` according to the user's Chrome Sync configuration and Google's applicable privacy practices.

## This policy website

This privacy-policy page is hosted by Cloudflare. PR Side does not add analytics, advertising scripts, tracking pixels, or cookies to this page. Cloudflare may process standard request information, such as IP addresses and security logs, to deliver and protect the page under Cloudflare's applicable privacy practices. Visiting this page is separate from using the PR Side extension.

## Permissions

- `https://github.com/*`: retrieves the signed-in user's authored and review-requested pull-request pages and opens matching pull requests.
- `tabs` and `tabGroups`: finds, creates, groups, updates, and removes GitHub pull-request tabs managed by PR Side.
- `storage`: saves user-selected settings and local synchronization state.
- `alarms`: runs synchronization at the interval selected by the user.

## Limited Use

PR Side's use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Information is used only to provide or improve PR Side's user-facing single purpose. It is not transferred for advertising, sold to data brokers, used for creditworthiness or lending, or made available for humans to read, except where required by law or expressly requested by the user for support.

## Security

All GitHub requests made by PR Side use HTTPS. PR Side does not load or execute remotely hosted code.

## Changes to this policy

Material changes to this policy will be published at this URL with an updated effective date before a corresponding extension update is released.

## Contact

Privacy questions can be submitted through the support contact listed on the PR Side Chrome Web Store page.

The public version of this policy is available at <https://prside.102lab.com/privacy/>.
