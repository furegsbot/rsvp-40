const fs = require('fs');
const path = require('path');

const GUESTLIST_PATH = path.join(__dirname, '..', 'gaesteliste-40-geburtstag.md');
const RSVP_JSON_PATH = path.join(__dirname, '..', 'data', 'rsvp.json');

// Load RSVP data
let rsvpEntries = [];
if (fs.existsSync(RSVP_JSON_PATH)) {
  try {
    rsvpEntries = JSON.parse(fs.readFileSync(RSVP_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to load RSVP JSON:', e);
    process.exit(1);
  }
}

// Filter to only confirmed (attending=1) and declined (attending=0) from last 14 days
const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
const recentRSVPs = rsvpEntries.filter(entry => 
  new Date(entry.timestamp) > twoWeeksAgo
);

const confirmed = recentRSVPs.filter(e => e.attending === 1);
const declined = recentRSVPs.filter(e => e.attending === 0);

console.log(`Recent RSVPs: ${recentRSVPs.length} (${confirmed.length} confirmed, ${declined.length} declined)`);

// Read guestlist
let content = fs.readFileSync(GUESTLIST_PATH, 'utf8');
const lines = content.split('\n');

// Find table section
let tableStart = -1;
let tableEnd = -1;
let inTable = false;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('|-------------')) {
    if (!inTable) {
      inTable = true;
      tableStart = i - 1; // header line
    } else {
      tableEnd = i;
      break;
    }
  }
}

if (tableStart === -1 || tableEnd === -1) {
  console.error('Could not find table in guestlist.');
  process.exit(1);
}

// Parse table rows
const rows = [];
for (let i = tableStart + 2; i < tableEnd; i++) { // skip header and separator
  const line = lines[i];
  const cells = line.split('|').map(c => c.trim()).filter(c => c);
  if (cells.length >= 5) {
    const nameCell = cells[0];
    // Extract name without status emojis
    const name = nameCell.replace(/[✅👍👎❓📞🍴🧒]/g, '').trim();
    const adults = parseInt(cells[1]) || 0;
    const children = parseInt(cells[2]) || 0;
    const status = cells[3];
    const notes = cells[4] || '';
    rows.push({
      originalLine: line,
      lineIndex: i,
      name,
      adults,
      children,
      status,
      notes
    });
  }
}

// Helper to match names (fuzzy matching)
function nameMatches(rsvpName, guestName) {
  const normalize = (str) => str.toLowerCase().replace(/[^a-zäöüß]/g, '');
  const rsvpNorm = normalize(rsvpName);
  const guestNorm = normalize(guestName);
  
  // Exact match
  if (rsvpNorm === guestNorm) return true;
  
  // Partial match (e.g., "Daniel" matches "Daniel Muth und Frau")
  if (guestNorm.includes(rsvpNorm) || rsvpNorm.includes(guestNorm)) return true;
  
  // Check for common prefixes
  const commonPrefixes = ['familie ', 'herr ', 'frau ', 'und ', '& ', '+ '];
  let cleanGuest = guestNorm;
  commonPrefixes.forEach(p => {
    if (cleanGuest.startsWith(p)) cleanGuest = cleanGuest.slice(p.length);
  });
  if (cleanGuest.includes(rsvpNorm)) return true;
  
  return false;
}

// Update rows based on RSVPs
rows.forEach(row => {
  // Check for confirmed RSVP
  const confirmedEntry = confirmed.find(rsvp => nameMatches(rsvp.name, row.name));
  const declinedEntry = declined.find(rsvp => nameMatches(rsvp.name, row.name));
  
  if (confirmedEntry) {
    row.status = '👍';
    // Update adults/children if RSVP has different numbers?
    // For now keep original numbers
  } else if (declinedEntry) {
    row.status = '👎';
  } else {
    // If no RSVP yet and status is still "to contact", keep it
    if (row.status === '📞' || row.status === '❓') {
      // unchanged
    }
  }
});

// Rebuild table lines
const newTableLines = [
  lines[tableStart], // header
  lines[tableStart + 1], // separator
];

rows.forEach(row => {
  const cells = [
    row.name + (row.status ? ' ' + row.status : ''),
    row.adults.toString(),
    row.children.toString(),
    row.status,
    row.notes
  ];
  newTableLines.push('| ' + cells.join(' | ') + ' |');
});

newTableLines.push(lines[tableEnd]); // closing separator

// Replace old table with new table
lines.splice(tableStart, tableEnd - tableStart + 1, ...newTableLines);

// Update statistics section
let totalAdults = 0;
let totalChildren = 0;
let totalConfirmedAdults = 0;
let totalConfirmedChildren = 0;

rows.forEach(row => {
  totalAdults += row.adults;
  totalChildren += row.children;
  if (row.status === '👍') {
    totalConfirmedAdults += row.adults;
    totalConfirmedChildren += row.children;
  }
});

// Find and update statistics
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('### Erwachsene')) {
    let j = i + 1;
    while (j < lines.length && !lines[j].includes('### Kinder')) {
      if (lines[j].includes('**Bestätigt:**')) {
        lines[j] = `- **Bestätigt:** ${totalConfirmedAdults}`;
      } else if (lines[j].includes('**Eingeladen:**')) {
        lines[j] = `- **Eingeladen:** ${totalAdults}`;
      } else if (lines[j].includes('**Gesamt (potenziell):**')) {
        lines[j] = `- **Gesamt (potenziell):** ${totalAdults}`;
      }
      j++;
    }
  }
  
  if (lines[i].includes('### Kinder')) {
    let j = i + 1;
    while (j < lines.length && !lines[j].includes('### Gesamtpersonen')) {
      if (lines[j].includes('**Bestätigt:**')) {
        lines[j] = `- **Bestätigt:** ${totalConfirmedChildren}`;
      } else if (lines[j].includes('**Eingeladen:**')) {
        lines[j] = `- **Eingeladen:** ${totalChildren}`;
      } else if (lines[j].includes('**Gesamt (potenziell):**')) {
        lines[j] = `- **Gesamt (potenziell):** ${totalChildren}`;
      }
      j++;
    }
  }
  
  if (lines[i].includes('### Gesamtpersonen')) {
    let j = i + 1;
    while (j < lines.length && !lines[j].includes('## 🎯 Nächste Schritte')) {
      if (lines[j].includes('**Bestätigt:**')) {
        lines[j] = `- **Bestätigt:** ${totalConfirmedAdults + totalConfirmedChildren}`;
      } else if (lines[j].includes('**Eingeladen:**')) {
        lines[j] = `- **Eingeladen:** ${totalAdults + totalChildren}`;
      } else if (lines[j].includes('**Gesamt (potenziell):**')) {
        lines[j] = `- **Gesamt (potenziell):** ${totalAdults + totalChildren}`;
      }
      j++;
    }
  }
}

// Write back
fs.writeFileSync(GUESTLIST_PATH, lines.join('\n'), 'utf8');
console.log('Guestlist updated successfully.');
console.log(`Total adults: ${totalAdults}, children: ${totalChildren}`);
console.log(`Confirmed adults: ${totalConfirmedAdults}, children: ${totalConfirmedChildren}`);

// Also write a simple summary file
const summary = {
  updatedAt: new Date().toISOString(),
  totalAdults,
  totalChildren,
  confirmedAdults: totalConfirmedAdults,
  confirmedChildren: totalConfirmedChildren,
  confirmedGuests: rows.filter(r => r.status === '👍').length,
  declinedGuests: rows.filter(r => r.status === '👎').length,
  pendingGuests: rows.filter(r => r.status === '📞' || r.status === '❓').length
};

fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'guestlist-summary.json'),
  JSON.stringify(summary, null, 2),
  'utf8'
);