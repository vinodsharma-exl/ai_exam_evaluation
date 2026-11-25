# AnswerEval AI: Getting started with a free Google Gemini key

AnswerEval AI reads handwritten answer sheets and **recommends** marks. **You always decide the final marks.** Everything is saved on your computer. The only thing sent over the internet is the page images and answer text sent to the AI service you choose.

## 1. Install (2 minutes)

1. Double-click **AnswerEval-AI-Setup.exe**. No administrator password is needed.
2. If Windows shows *"Windows protected your PC"*, click **More info**, then **Run anyway**. This appears because the app isn't signed by a publisher yet.
3. Open **AnswerEval AI** from the Start menu or the desktop. Enter your name and an optional 4–8 digit PIN, then read the short privacy note.

## 2. Get your free Gemini key (5 minutes)

1. Open **https://aistudio.google.com/apikey** in your browser. You can also go to **Settings → Providers & keys → Google Gemini → Get a key** in the app.
2. Sign in with your Google account and accept the terms. You need to be 18+ and in a country where AI Studio is available.
3. Click **Create API key**. If asked, let it create a new project. **No credit card is needed.**
4. Click **Copy**. The key is a long code that starts with **AIza**. Treat it like a password: don't email it or share it. You can delete it in AI Studio and make a new one at any time.

## 3. Put the key into AnswerEval AI

1. In the app, go to **Settings → Providers & keys → Google Gemini**.
2. Paste the key into **API key** and click **Save key**. It is stored encrypted on this computer only.
3. In the table under the key, click **Test** next to *gemini-2.5-flash*. You should see **✓ Connected · vision ✓** ("vision" means it can read page images).

## 4. Check your free limits (important)

Google sets free limits **per project** and changes them from time to time. Recently they have been as low as about **5 requests a minute and 20 a day** per model.

1. In AI Studio, open the **usage / rate limits** page for your project and note the *requests per minute* and *requests per day* for **Gemini 2.5 Flash** and **Flash-Lite**.
2. In the app, open **Settings → Providers & keys → Google Gemini**, click **Limits** for each model and enter those numbers. The app paces itself to them.

**Roughly what to expect:** one answer sheet takes about 1–2 requests to read (2–3 pages per request) plus 1 to grade. The app shows an estimate before every run, like *"~3 AI requests, about a minute"*.

## 5. Make the free limit go further

- **Two models, two quotas.** By default the app reads pages with *Gemini 2.5 Flash* and grades with *Gemini 2.5 Flash-Lite*. Each has its own daily limit, so one key does twice the work.
- **Add a second free service for grading** (optional). Get a free **Groq** key at *console.groq.com/keys*, add it under **Settings → Providers & keys → Groq**, then choose Groq for **Grading** in **Settings → AI models**. Gemini is then used only for reading handwriting.
- **Typed question papers cost almost nothing.** For PDFs made on a computer, the app reads the text directly instead of the images.
- **Let it run overnight.** In **Reports**, choose **Process all (queued)**. When today's limit runs out, work pauses and continues the next time you open the app. Pages already read are never sent again.
- **Keep Image quality on Medium** (Settings → Image quality). Use **High** only for faint pencil.

## 6. Grading a class

1. **Question Paper & Model → New exam**: upload or paste the question paper, click **Read with AI**, check the table, then do the same for the model answer and click **Save exam template**.
2. **Reports**: drop all the answer sheets at once. File names like `21CS045_Asha Kumar.pdf` become the student ID and name. Then click **Process all (queued)**.
3. Open each student and check every **Needs Review** question. Change marks if needed, then **Finalize**.
4. **Generate Report** gives each student a PDF. **Class sheet (Excel)** gives you the whole class in one file.

## If something goes wrong

| You see | What to do |
|---|---|
| *API key not accepted* | Copy the key again, with no spaces, and paste it in Settings → Providers & keys. |
| *Today's free limit is used up* | Nothing is lost. Press **Resume** tomorrow, or choose another model/provider in Settings → AI models. |
| *Waiting for rate limit, resuming in 42s* | Normal on a free plan. Leave it running. |
| *This model cannot read images* | Choose Gemini 2.5 Flash for **Reading** in Settings → AI models, or click **Type the text instead**. |
| *Model not found* | Free model names change. In Settings → AI models, press the refresh button next to Model and pick the newest *Flash*. |
| *Page looked blank and was skipped* | If it isn't blank, click **Read anyway** on the results screen. |
| A mark looks wrong | Open the question, compare the original image with the extracted text, correct either, and set your own mark. |

**Privacy:** Free AI plans may keep what you send and use it to improve their models. Use student IDs instead of names on sheets where you can, and follow your institution's rules on student data.

**Your data** lives in **Documents\AnswerEvalAI**. Make a backup any time in **Settings → Data folder → Create backup (ZIP)**. Uninstalling the app does not delete your data.
