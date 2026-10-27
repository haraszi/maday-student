# Ildi Haraszi: Career Coaching website

A one-page website for DISC-based career coaching for university students.

## What's in this folder

- `public/index.html`: the whole web page (text, layout and colours)
- `public/images/ildi.jpg`: your photo
- `wrangler.jsonc`: a small settings file that tells Cloudflare how to host the site

## Things still to fill in

Open `public/index.html` in Notepad and search (Ctrl+F) for `REPLACE`:

1. **Testimonials**: replace the three dashed testimonial boxes.

The booking buttons go to https://cal.com/ildiko-haraszi-lc4hy4. To change it, search for `cal.com` and replace all three.

## Hosting

The site is hosted on Cloudflare Workers and connected to GitHub. Every time a change
is saved to GitHub, Cloudflare updates the live site automatically within about a minute.
