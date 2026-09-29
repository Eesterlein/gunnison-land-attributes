# Drop new data downloads here

Upload the latest assessor downloads to this folder (on GitHub: **Add file → Upload files**, then **Commit changes**):

- `Land Attributes <date>.xlsx`
- `Public Data - GENERAL ACCT INFO <date>.xlsx`
- `Public Data - VALUES <date>.xlsx`

`.xlsx` or `.csv` both work, and file names don't matter; each file is recognized by its column headers. You can upload one, two or all three. Anything you don't upload keeps its previous version.

A GitHub Action then cleans the files, rebuilds the dashboard data, removes the uploads from this folder (keeping only the columns the dashboard uses, with no owner names or mailing addresses), and republishes the site. It usually takes 1–2 minutes. Progress is on the repository's **Actions** tab.
