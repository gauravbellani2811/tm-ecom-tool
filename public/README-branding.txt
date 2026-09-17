Brand assets for Fabric Styler (T. Mangharam)
=============================================

Drop your two image files into THIS folder with these exact names:

  tm-logo.png       — the circular TM monogram logo
  tm-wordmark.png   — the "T.MANGHARAM" wordmark (text)

They are referenced by the app as "/tm-logo.png" and "/tm-wordmark.png".
PNG with a transparent background looks best, but white background is fine
(the app uses mix-blend-mode so a white background blends into the page).

If a file is missing, the app falls back gracefully:
  - missing logo  -> logo simply hidden
  - missing wordmark -> styled text "T. MANGHARAM" shown instead

After adding/replacing the files, redeploy (vercel --prod) so they go live.
