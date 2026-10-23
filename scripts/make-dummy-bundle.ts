/**
 * Generate a small synthetic bundle for testing, plus its answer key.
 *   npx tsx scripts/make-dummy-bundle.ts [out-name]
 *
 * Twelve single-page documents: 2 receipts, 1 MRI report, 3 x-ray reports,
 * 1 blood report, 4 prescriptions, and 1 blood-sugar result belonging to
 * someone else.
 *
 * Deliberately written about Daniel James Marsh, the client in the hardcoded
 * brief, with the stray result belonging to Kylie Marsh — his partner, who the
 * brief already names as NOT the client. That makes this runnable as-is: the
 * relatedness check has something true to find rather than rejecting all twelve
 * documents for being about the wrong person.
 *
 * All details are fictional.
 */
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0.09, 0.1, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.78, 0.8, 0.84);

interface Doc {
  id: string;
  type: string;
  subtype: string;
  desc: string;
  date: string;
  author: string;
  discipline: string;
  org: string;
  orgLine: string;
  relates: 'yes' | 'no';
  patient: string;
  dob: string;
  /** Body lines; a blank string becomes vertical space. */
  body: string[];
  heading: string;
  review?: string;
}

const CLIENT = { name: 'DANIEL JAMES MARSH', dob: '14/03/1984' };
const PARTNER = { name: 'KYLIE ANNE MARSH', dob: '21/06/1986' };
const CLAIM = 'UI-22-0815-4471';

const DOCS: Doc[] = [
  {
    id: 'D001',
    type: 'Receipts',
    subtype: 'Payment receipt',
    desc: 'Receipt for general practice consultation fee',
    date: '12/03/2024',
    author: 'Northbank Medical Centre',
    discipline: 'General practice',
    org: 'Northbank Medical Centre',
    orgLine: '44 Northbank Road, Carrick Park QLD 4127  ·  ABN 55 821 004 117',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'TAX INVOICE / RECEIPT',
    body: [
      'Receipt number      NMC-2024-04417',
      'Date of service     12/03/2024',
      '',
      'Item 23   Standard consultation, Level B           $ 92.00',
      'Item 10990  Bulk billing adjustment               -$ 41.20',
      '',
      'Total paid                                         $ 50.80',
      'Payment method      EFTPOS                                   ',
      '',
      'Paid in full. This receipt may be used for rebate purposes.',
    ],
  },
  {
    id: 'D002',
    type: 'Receipts',
    subtype: 'Payment receipt',
    desc: 'Receipt for MRI lumbar spine scan fee',
    date: '18/03/2024',
    author: 'Westgate Imaging',
    discipline: 'Radiology',
    org: 'Westgate Imaging',
    orgLine: '2 Westgate Avenue, Brisbane QLD 4000  ·  ABN 71 447 902 338',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'TAX INVOICE / RECEIPT',
    body: [
      'Receipt number      WGI-88204',
      'Date of service     18/03/2024',
      'Referred by         Dr Anil Mehta',
      '',
      'MRI lumbar spine without contrast                  $ 420.00',
      'Medicare benefit assigned                         -$ 358.00',
      '',
      'Total paid                                         $  62.00',
      'Payment method      Credit card',
      '',
      'Paid in full.',
    ],
  },
  {
    id: 'D003',
    type: 'Imaging Reports',
    subtype: 'MRI',
    desc: 'MRI lumbar spine report showing post-operative changes at L4/5',
    date: '18/03/2024',
    author: 'Dr Helen Cho',
    discipline: 'Radiology',
    org: 'Westgate Imaging',
    orgLine: '2 Westgate Avenue, Brisbane QLD 4000  ·  Ph 07 5550 7788',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'MRI LUMBAR SPINE — REPORT',
    body: [
      'Referred by     Dr Anil Mehta, Northbank Medical Centre',
      'Examination     MRI lumbar spine without contrast',
      'Date            18/03/2024',
      '',
      'CLINICAL HISTORY',
      'Ongoing low back pain with left leg radiation. Left L4/5',
      'microdiscectomy November 2022. Assess for recurrent disc protrusion.',
      '',
      'FINDINGS',
      'Post-surgical change at the left L4/5 laminotomy site with expected',
      'granulation tissue. No recurrent disc protrusion is identified. The',
      'L4/5 disc shows reduced height and Modic type II endplate change.',
      'Mild bilateral facet arthropathy at L4/5 and L5/S1. The conus',
      'terminates at T12/L1 and is normal in signal.',
      '',
      'No canal stenosis. Neural foramina are patent bilaterally.',
      '',
      'CONCLUSION',
      'Expected post-operative appearances at left L4/5. No recurrent disc',
      'protrusion and no nerve root compression.',
      '',
      'Reported by Dr Helen Cho, FRANZCR',
    ],
  },
  {
    id: 'D004',
    type: 'Imaging Reports',
    subtype: 'X-ray',
    desc: 'X-ray lumbar spine report, AP and lateral views',
    date: '22/08/2022',
    author: 'Dr Helen Cho',
    discipline: 'Radiology',
    org: 'Westgate Imaging',
    orgLine: '2 Westgate Avenue, Brisbane QLD 4000  ·  Ph 07 5550 7788',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'X-RAY LUMBAR SPINE — REPORT',
    body: [
      'Referred by     Dr Anil Mehta, Northbank Medical Centre',
      'Examination     Lumbar spine, AP and lateral views',
      'Date            22/08/2022',
      '',
      'CLINICAL HISTORY',
      'Low back pain following lifting injury at work on 08/08/2022.',
      '',
      'FINDINGS',
      'Five non-rib-bearing lumbar vertebrae. Vertebral body heights are',
      'preserved. Mild disc space narrowing at L4/5. No spondylolisthesis',
      'on the lateral view. Sacroiliac joints appear unremarkable.',
      '',
      'No acute fracture is identified.',
      '',
      'CONCLUSION',
      'Mild degenerative disc disease at L4/5. No acute bony injury.',
      '',
      'Reported by Dr Helen Cho, FRANZCR',
    ],
  },
  {
    id: 'D005',
    type: 'Imaging Reports',
    subtype: 'X-ray',
    desc: 'X-ray chest report, pre-operative screening',
    date: '05/11/2022',
    author: 'Dr Helen Cho',
    discipline: 'Radiology',
    org: 'Westgate Imaging',
    orgLine: '2 Westgate Avenue, Brisbane QLD 4000  ·  Ph 07 5550 7788',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'X-RAY CHEST — REPORT',
    body: [
      'Referred by     Dr Marcus Reid, Meridian Orthopaedics',
      'Examination     Chest, PA view',
      'Date            05/11/2022',
      '',
      'CLINICAL HISTORY',
      'Pre-operative screening prior to lumbar microdiscectomy.',
      '',
      'FINDINGS',
      'The lungs are clear. No focal consolidation, effusion or',
      'pneumothorax. Cardiomediastinal contours are within normal limits.',
      'The bony thorax is intact.',
      '',
      'CONCLUSION',
      'Normal chest radiograph. No contraindication to surgery identified.',
      '',
      'Reported by Dr Helen Cho, FRANZCR',
    ],
  },
  {
    id: 'D006',
    type: 'Imaging Reports',
    subtype: 'X-ray',
    desc: 'X-ray left knee report following a fall',
    date: '14/06/2023',
    author: 'Dr Priya Nandakumar',
    discipline: 'Radiology',
    org: 'Meridian Radiology',
    orgLine: '9 Meridian Street, Wynnum Bay QLD 4178  ·  Ph 07 5550 2210',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'X-RAY LEFT KNEE — REPORT',
    body: [
      'Referred by     Dr Anil Mehta, Northbank Medical Centre',
      'Examination     Left knee, AP and lateral views',
      'Date            14/06/2023',
      '',
      'CLINICAL HISTORY',
      'Fall at home, left knee pain and swelling. Query fracture.',
      '',
      'FINDINGS',
      'No acute fracture or dislocation. Joint spaces are preserved. No',
      'significant effusion. Patella is normally positioned on the lateral',
      'view. Mild early degenerative change in the medial compartment.',
      '',
      'CONCLUSION',
      'No acute bony injury to the left knee.',
      '',
      'Reported by Dr Priya Nandakumar, FRANZCR',
    ],
  },
  {
    id: 'D007',
    type: 'Pathology Reports',
    subtype: 'Full blood count',
    desc: 'Full blood count and inflammatory markers, within normal limits',
    date: '02/02/2024',
    author: 'Dr Samuel Obi',
    discipline: 'Pathology',
    org: 'Carrick Park Pathology',
    orgLine: '17 Grange Road, Carrick Park QLD 4127  ·  NATA accredited',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'FULL BLOOD COUNT — RESULT',
    body: [
      'Requested by    Dr Anil Mehta, Northbank Medical Centre',
      'Collected       02/02/2024  08:20',
      'Lab reference   CPP-2024-11903',
      '',
      'TEST                        RESULT      UNITS      REFERENCE',
      'Haemoglobin                 148         g/L        130 - 180',
      'White cell count            6.4         x10^9/L    4.0 - 11.0',
      'Platelets                   244         x10^9/L    150 - 400',
      'Neutrophils                 3.8         x10^9/L    2.0 -  7.5',
      'Lymphocytes                 2.0         x10^9/L    1.0 -  4.0',
      'C-reactive protein          2.1         mg/L       < 5.0',
      'ESR                         7           mm/hr      < 15',
      '',
      'COMMENT',
      'Full blood count and inflammatory markers within normal limits.',
      '',
      'Authorised by Dr Samuel Obi, FRCPA',
    ],
  },
  {
    id: 'D008',
    type: 'Prescriptions',
    subtype: 'Prescription',
    desc: 'Prescription for analgesia following workplace back injury',
    date: '09/08/2022',
    author: 'Dr Anil Mehta',
    discipline: 'General practice',
    org: 'Northbank Medical Centre',
    orgLine: '44 Northbank Road, Carrick Park QLD 4127  ·  Prescriber 4471902',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'PRESCRIPTION',
    body: [
      'Date of prescribing   09/08/2022',
      '',
      'Paracetamol 665 mg modified release',
      '   Two tablets three times daily as required',
      '   Quantity 96        Repeats 1',
      '',
      'Ibuprofen 400 mg tablets',
      '   One tablet three times daily with food, as required',
      '   Quantity 30        Repeats 0',
      '',
      'Prescriber   Dr Anil Mehta, MBBS FRACGP',
    ],
  },
  {
    id: 'D009',
    type: 'Prescriptions',
    subtype: 'Prescription',
    desc: 'Post-operative prescription for pain relief and constipation',
    date: '15/11/2022',
    author: 'Dr Marcus Reid',
    discipline: 'Orthopaedic surgery',
    org: 'Meridian Orthopaedics',
    orgLine: '9 Meridian Street, Wynnum Bay QLD 4178  ·  Prescriber 2284110',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'PRESCRIPTION',
    body: [
      'Date of prescribing   15/11/2022',
      '',
      'Oxycodone 5 mg immediate release',
      '   One tablet every 6 hours as required for severe pain',
      '   Quantity 20        Repeats 0',
      '',
      'Docusate with sennoside tablets',
      '   One tablet at night',
      '   Quantity 30        Repeats 1',
      '',
      'Prescriber   Dr Marcus Reid, MBBS FRACS (Orth)',
    ],
  },
  {
    id: 'D010',
    type: 'Prescriptions',
    subtype: 'Prescription',
    desc: 'Prescription for neuropathic pain, dose increase',
    date: '20/01/2023',
    author: 'Dr Marcus Reid',
    discipline: 'Orthopaedic surgery',
    org: 'Meridian Orthopaedics',
    orgLine: '9 Meridian Street, Wynnum Bay QLD 4178  ·  Prescriber 2284110',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'PRESCRIPTION',
    body: [
      'Date of prescribing   20/01/2023',
      '',
      'Pregabalin 75 mg capsules',
      '   One capsule twice daily, increasing to 150 mg twice daily',
      '   after two weeks if tolerated',
      '   Quantity 56        Repeats 2',
      '',
      'Prescriber   Dr Marcus Reid, MBBS FRACS (Orth)',
    ],
  },
  {
    id: 'D011',
    type: 'Prescriptions',
    subtype: 'Prescription',
    desc: 'Repeat prescription for ongoing neuropathic pain management',
    date: '10/03/2024',
    author: 'Dr Anil Mehta',
    discipline: 'General practice',
    org: 'Northbank Medical Centre',
    orgLine: '44 Northbank Road, Carrick Park QLD 4127  ·  Prescriber 4471902',
    relates: 'yes',
    patient: CLIENT.name,
    dob: CLIENT.dob,
    heading: 'PRESCRIPTION',
    body: [
      'Date of prescribing   10/03/2024',
      '',
      'Pregabalin 150 mg capsules',
      '   One capsule twice daily',
      '   Quantity 56        Repeats 5',
      '',
      'Paracetamol 665 mg modified release',
      '   Two tablets three times daily as required',
      '   Quantity 96        Repeats 5',
      '',
      'Prescriber   Dr Anil Mehta, MBBS FRACGP',
    ],
  },
  {
    // The one that must be caught. Same surname, same address, same lab,
    // same collection date as D007 — everything matches except the person.
    id: 'D012',
    type: 'Pathology Reports',
    subtype: 'Blood sugar',
    desc: 'Blood glucose and HbA1c result belonging to the client’s partner',
    date: '02/02/2024',
    author: 'Dr Samuel Obi',
    discipline: 'Pathology',
    org: 'Carrick Park Pathology',
    orgLine: '17 Grange Road, Carrick Park QLD 4127  ·  NATA accredited',
    relates: 'no',
    patient: PARTNER.name,
    dob: PARTNER.dob,
    review: 'Different patient — same surname and address as the client',
    heading: 'BLOOD GLUCOSE / HbA1c — RESULT',
    body: [
      'Requested by    Dr Anil Mehta, Northbank Medical Centre',
      'Collected       02/02/2024  08:35',
      'Lab reference   CPP-2024-11907',
      '',
      'TEST                        RESULT      UNITS      REFERENCE',
      'Fasting glucose             6.4         mmol/L     3.0 - 5.4',
      'HbA1c                       6.1         %          < 6.0',
      'HbA1c (IFCC)                43          mmol/mol   < 42',
      '',
      'COMMENT',
      'Fasting glucose and HbA1c are mildly elevated, consistent with',
      'impaired glucose tolerance. Suggest dietary review and repeat',
      'testing in three months.',
      '',
      'Authorised by Dr Samuel Obi, FRCPA',
    ],
  },
];

function drawPage(
  page: PDFPage,
  doc: Doc,
  fonts: { regular: PDFFont; bold: PDFFont; mono: PDFFont },
) {
  const [w, h] = A4;
  const left = 56;
  let y = h - 58;

  // Letterhead — a fresh one on every page is what tells the splitter that a
  // new document starts here.
  page.drawText(doc.org, { x: left, y, size: 15, font: fonts.bold, color: INK });
  y -= 14;
  page.drawText(doc.orgLine, { x: left, y, size: 7.5, font: fonts.regular, color: MUTED });
  y -= 14;
  page.drawLine({
    start: { x: left, y },
    end: { x: w - left, y },
    thickness: 1,
    color: RULE,
  });

  y -= 26;
  page.drawText(doc.heading, { x: left, y, size: 11.5, font: fonts.bold, color: INK });

  // Patient block. Name and date of birth on every page is what makes the
  // relatedness check answerable.
  y -= 22;
  page.drawText('Patient', { x: left, y, size: 8, font: fonts.regular, color: MUTED });
  page.drawText(doc.patient, { x: left + 76, y, size: 9.5, font: fonts.bold, color: INK });
  y -= 13;
  page.drawText('Date of birth', { x: left, y, size: 8, font: fonts.regular, color: MUTED });
  page.drawText(doc.dob, { x: left + 76, y, size: 9, font: fonts.regular, color: INK });

  if (doc.relates === 'yes') {
    y -= 13;
    page.drawText('Claim number', { x: left, y, size: 8, font: fonts.regular, color: MUTED });
    page.drawText(CLAIM, { x: left + 76, y, size: 9, font: fonts.regular, color: INK });
  }

  y -= 24;
  page.drawLine({
    start: { x: left, y },
    end: { x: w - left, y },
    thickness: 0.5,
    color: RULE,
  });

  y -= 20;
  for (const line of doc.body) {
    if (line) {
      const isHeading = /^[A-Z][A-Z \/]{3,}$/.test(line);
      page.drawText(line, {
        x: left,
        y,
        size: isHeading ? 8.5 : 9,
        font: isHeading ? fonts.bold : fonts.mono,
        color: INK,
      });
    }
    y -= 13.5;
  }

  page.drawText(`${doc.org}  ·  Page 1 of 1`, {
    x: left,
    y: 42,
    size: 7,
    font: fonts.regular,
    color: MUTED,
  });
}

const quote = (f: string) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);

async function main() {
  const outName = process.argv[2] ?? 'testdata/dummy-12-mixed';

  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };

  for (const doc of DOCS) {
    drawPage(pdf.addPage(A4), doc, fonts);
  }
  pdf.setTitle('Test bundle — mixed records');
  await writeFile(`${outName}.pdf`, await pdf.save());

  const header = [
    'id', 'pages', 'n', 'type', 'desc', 'date', 'author',
    'discipline', 'org', 'relates', 'dup', 'review', 'note', 'fmt',
  ];
  const rows = DOCS.map((d, i) => [
    d.id,
    String(i + 1),
    '1',
    d.type,
    d.desc,
    d.date,
    d.author,
    d.discipline,
    d.org,
    d.relates,
    '',
    d.review ?? '',
    '',
    'Digital (text layer)',
  ]);
  await writeFile(
    `${outName}_answer_key.csv`,
    [header, ...rows].map((r) => r.map(quote).join(',')).join('\n') + '\n',
  );

  const byType = new Map<string, number>();
  for (const d of DOCS) byType.set(d.type, (byType.get(d.type) ?? 0) + 1);

  console.log(`\n${outName}.pdf  —  ${DOCS.length} pages, ${DOCS.length} documents`);
  console.log(`${outName}_answer_key.csv  —  answer key\n`);
  console.log('Expected grouping:');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(2)}  ${t}`);
  }
  console.log(
    `\nEvery document is about ${CLIENT.name} except ${DOCS.find((d) => d.relates === 'no')!.id},`,
  );
  console.log(`which belongs to ${PARTNER.name} — same surname, same address, same lab,`);
  console.log('same collection date. Only the name and date of birth differ.\n');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
