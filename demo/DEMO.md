# UniView board demo (about 8 minutes)

Plain steps. Everything runs on this PC; nothing goes to the internet.

## Before the meeting (2 minutes)

1. Double-click `demo\1-start-demo.cmd`. UniView opens.
2. Close the extra tabs it opened so the board starts on the home screen (the **Home** button).
3. Have `demo\files` open in Explorer on the side.

## Part 1: it opens anything, instantly (3 minutes)

1. Drag these from `demo\files` into the UniView window, all at once: `report.pdf`, `charter.docx`, `deck.pptx`, `sales.xlsx`, `notes.md`, `app.ts`.
   Say: "Six different kinds of file, one app, one tab each. No Word, no Excel, no PowerPoint installed."
2. Click each tab. Point out the PowerPoint shapes and the spreadsheet sheets (**Sales**, **Plan**).
3. The big one: drag `I:\AES\Data\uniview-lan-test\share\Media\big.mp4` (174 MB video) into the window.
   Say: "174 megabytes. It plays and you can jump around instantly, because it streams instead of loading."
4. Privacy: "There are no accounts and no tracking. Our test suite fails if the app tries to reach the internet."

## Part 2: the new feature, an AI assistant asks for your approval (3 minutes)

1. Double-click `demo\2-assistant-review.cmd`. A black window appears: this is the "assistant" asking for a review and waiting.
2. In UniView a new **Review** tab appears. Say: "The assistant shows its report. The grey box is marked as coming from the assistant. Its words cannot press the buttons."
3. Wait one second. Say: "The buttons arm after half a second on purpose, so nothing can click them for you."
4. Type a comment if you like, then click **Approve**.
5. Look at the black window: it prints the decision (`"decision":"approved"`) and exits. Say: "The assistant gets your answer. If anyone had changed those files after you looked, UniView would have refused to approve."
6. To show the other answer, run it again (it resets itself) and click **Request changes**.
7. Click the robot icon in the top bar: the **Agents** panel lists assistants and lets you revoke them.

## Part 3: phone (2 minutes, only with a real phone)

1. On the PC: open the sharing screen (folder icon, top right of the app), pick a folder, and show the QR code.
2. On the phone: UniView app, **Connect a computer**, scan the QR. On the PC click **Allow**.
3. Browse the PC folder from the phone and open the video. Say: "Same instant opening, nothing copied to the phone."
4. Click **Revoke** on the PC: the phone loses access immediately.

## If something goes wrong

* A tab shows "This file could not be displayed": close it and drag the file in again.
* The review does not appear: close UniView, run step 1 of "Before the meeting" again, then step Part 2.
* Say plainly what is not finished: the installer is not yet signed (a certificate is on order) and the Google Play release needs a 14-day test.
