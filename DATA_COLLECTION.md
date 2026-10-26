# History reports and radar test collection

Restart the dashboard server after installing this update, then refresh the browser. This is a dashboard update; no firmware upload is required. Local changes do not automatically update the published Render dashboard.

## Download history for a chosen period

1. Sign in and open **Event History**. Viewers can use **Alerts**, which has the same history controls.
2. Enter **From** and **To**, including the time. The timezone is shown below the controls. On a computer configured for Zimbabwe it is Africa/Harare (UTC+02:00).
3. Optionally choose an event type or sensor reference, then select **Apply / refresh**.
4. Select **Download PDF**. The report includes every retained matching event, even across multiple screen pages. A selection ending at 14:30 includes the whole minute through 14:30:59.999.
5. Select **All time** to clear the date, type and sensor filters. Either time boundary may be left blank. A period with no matches produces an explicitly empty report.

History retains the latest **10,000 events** across restarts. The live Analytics page still uses the latest 100 events; use Event History for the complete retained list. Previously discarded events cannot be recovered. History records changes such as detections, movement qualification and GSM status, not every distance or speed reading. Shared-scene events now use the **Combined** reference; older shared-scene events may be labelled Sensor 1. Events without a sensor reference are excluded by a sensor-specific filter.

## What to test

Start with the combined installation, fixed mounting and a clear area. Change one condition at a time. Mark distance from the sensor with a tape measure. Use a separate result for each repeat, with at least five repeats per condition as an initial collection.

| Trial | What to do | What to watch for |
| --- | --- | --- |
| Empty area | Observe for 60 seconds with nobody in the field. Repeat with fans or reflective objects changed. | Returns with zero people, unexpected alarms, environmental reflections. |
| Stationary | Stand at marked distances such as 1 m, 3 m and 5 m. | Missing stationary returns, count errors, distance error and unwanted alarms. |
| Slow approach | Walk slowly toward the sensors, moving at least 0.80 m radially in one continuous track. | Missed counts, missed qualified alarms and long delay. |
| Fast approach | Repeat at a faster safe walking pace. | Gaps, tracking changes and late alarms. |
| Moving away | Walk away over at least 0.80 m radial movement. | Direction errors and missed alarms. |
| Sideways | Move laterally while keeping radial distance nearly constant. | Sideways movement display; sideways-only movement should not qualify a radial alarm. |
| Multiple people | Begin with two people, separated; then try crossings or different directions. | Under-counting, duplicates and uncertain identities. |
| Edge / obstruction | Repeat a known trial at left/right edges and with a documented obstruction. | Blind areas, reduced range and unstable counts. |
| Connection / GSM | During a known qualifying movement trial, observe connection status and the receiving phone. | Delayed telemetry, buzzer response, SMS receipt and signal problems. |

Test each sensor separately only when its own reading can be identified. The normal shared radar view counts unique objects across both sensors; do not treat that count as an individual sensor's output. The dashboard's software range is 7 m. The test form accepts distances outside this range so limitations can be documented.

## How to enter each trial

1. Open **Recordings**, enter a label such as `Combined - slow approach - 3 m - repeat 1`, and select **Start recording**.
2. Perform the trial. Note the actual people present, people shown, whether the alarm occurred and whether SMS arrived on the receiving phone. Start the alarm-delay stopwatch at the beginning of the intended qualifying movement, using the same convention for every trial. For an SMS failure, record how long you waited in Notes. Allow the existing modem cooldown of 30 seconds after a transaction; a queued call/SMS can take longer.
3. Stop the recording on **Recordings**. A recording is captured on the server only while started; keep the telemetry source connected. Download measurements regularly. Recordings are capped at 20 files and 20 MB per file and do not automatically delete themselves.
4. Open **Test Results** and fill in the form:

| Field | What to enter |
| --- | --- |
| Test label | Scenario, distance, repeat number and change being tested. |
| Test date and time | When the trial was performed, in the timezone displayed on the page. |
| Scenario / tested sensor | Select the trial and use Combined for normal shared-dashboard observations. |
| Trial duration | Actual duration in seconds. |
| Actual people present | The known number of people in the tested field (0 for empty area). |
| People shown by radar | The count observed on the selected view at the comparison point. State that point or a time-varying problem in Notes. |
| Should an alarm occur? | Yes for a planned qualifying radial movement episode. No for empty area, standing still or purely sideways movement. Hardware persistence and tracking requirements still apply. |
| Did an alarm occur? | Your observed alarm result, not the intended result. |
| Tape-measured distance | The distance to one identified person at a marked position. |
| Radar distance | The displayed distance for that same person at that same moment. |
| Observed alarm delay | Seconds from the start of the intended movement to the alarm. Leave blank if unmeasured or no alarm occurred. Zero is retained as a measured zero. |
| SMS received on phone? | Yes / No only if you checked the receiving phone. Otherwise choose Not tested. Modem SENT is not proof of receipt. |
| Recording | Link the matching saved recording, if available. |
| Notes | Mounting height/angle, path, obstructions, person/target used for distance comparison, firmware, signal/connection problems, unexpected behavior and any change made. |

5. Select **Save test result**. Use **View / edit** in Saved trials to correct an entry. Administrators and Operators can enter/edit trials; Viewers can read and export them.
6. Review **Areas to improve**, then use the review time/sensor filters and **Download PDF** for a report of the selected trials, metrics, groups and notes. These filters use the trial time, not the time the entry was saved. They do not filter or change the entry form.

Example: a 60-second slow-approach trial with one person, one radar target, a required and observed alarm, tape distance 3.00 m, radar distance 2.80 m, alarm delay 2.1 s and confirmed phone receipt. Enter those values as one trial. Its absolute distance error is 0.20 m. Use new entries for subsequent repeats; editing updates the existing trial.

## Reading the weaknesses summary

- **Exact people count** is the percentage of entered trials with equal actual and observed counts. It is not a continuous detection accuracy measurement.
- **Under-counted occupied trials** have fewer displayed people than were actually present. **Empty-area returns** have detections when zero people were present.
- **Missed expected alarms** and **unexpected alarms** compare the two alarm selections. Denominators show how many applicable trials were entered.
- **Mean distance error** averages absolute differences only where both distance fields were measured.
- **Mean alarm delay** uses trials with an expected and observed alarm and an entered delay. Untimed and missed alarms are excluded, and missed alarms are shown separately.
- **SMS not received** uses only expected-alarm trials where receipt was checked. Untested SMS is excluded.
- The scenario/sensor table counts a trial as a **mismatch** if either its people count or alarm result differs. A matching trial can still have distance error, delay or SMS failure.

The summary describes entered observations and suggests follow-up tests; it cannot establish the physical cause of a failure. Small samples and different conditions do not establish reliability. Repeat weak conditions after one documented change and compare equivalent before/after collections.

## Keep the collection safe

Results are stored in `data/test-results.json` on the dashboard server (up to 10,000 entries; new entries are refused at that limit). Recordings remain under `data/recordings`; history remains in `data/events.json`. Download reports and measurement files and keep backups of these data files. On Render, use persistent storage: redeployment on an ephemeral filesystem can lose accounts, history, recordings and test results. No sample/test fixtures are added to your real collection by the automated checks.
