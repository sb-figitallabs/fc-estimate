# Due Mobilisation — daily upload files

| # | Report (standard export name) | What the tool takes from it | Needed for |
|---|---|---|---|
| 1 | **Daily Expenditure (HIMS)** | Admitted-patient census, **ward + bed** (`WARDNAME`), running bill, advance | Bed number, room type, the census spine |
| 2 | **Track Bills Report (FC)** | Running bill, total advance, due amount, FC estimate | Bill, collected, estimate |
| 3 | **Interim Enhancements (FC)** | Enhancement status, trigger status, approved amount (when filled) | The enhancement worklist |
| 4 | **Financial Counselling (FC)** | FC estimate / counselled amount | Latest estimate |
| 5 | **Transaction TAT Report (Insurance)** | **The insurer Approved Amount** (+ claimed amount, claim status) | **Approved amount** & the "bill vs approved" picture |
| 6 | Recounselling Report *(optional)* | Re-counselling follow-ups | Supporting |
| 7 | Planned Admission Report *(optional)* | Upcoming admissions | Supporting |

Reports **1–5 are the core**; 6–7 are supporting.