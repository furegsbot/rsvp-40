const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;

if (!IMAP_USER || !IMAP_PASS) {
  console.error('IMAP_USER or IMAP_PASS environment variables not set');
  process.exit(1);
}

const IMAP_CONFIG = {
  user: IMAP_USER,
  password: IMAP_PASS,
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
};

const DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTLIST_PATH = path.join(__dirname, '..', 'gaesteliste-40-geburtstag.md');
const RSVP_JSON_PATH = path.join(DATA_DIR, 'rsvp.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load existing RSVP data
let existingRSVPs = [];
if (fs.existsSync(RSVP_JSON_PATH)) {
  try {
    existingRSVPs = JSON.parse(fs.readFileSync(RSVP_JSON_PATH, 'utf8'));
  } catch (e) {
    console.warn('Could not parse existing RSVP JSON, starting fresh');
  }
}

function parseEmailHTML(html) {
  const $ = cheerio.load(html);
  const data = {};
  
  // Try to find table rows (FormSubmit.co format)
  $('tr').each((i, tr) => {
    const th = $(tr).find('th').text().trim().toLowerCase();
    const td = $(tr).find('td').text().trim();
    if (th && td) {
      if (th.includes('name')) data.name = td;
      if (th.includes('erwachsene') || th.includes('adults')) data.adults = parseInt(td) || 0;
      if (th.includes('kinder') || th.includes('children')) data.children = parseInt(td) || 0;
      if (th.includes('teilnahme') || th.includes('attending')) {
        data.attending = td.toLowerCase().includes('ja') || td.toLowerCase().includes('yes') ? 1 : 0;
      }
      if (th.includes('kommentar') || th.includes('comments')) data.comments = td;
    }
  });
  
  // Fallback: look for strong tags followed by text
  $('strong').each((i, strong) => {
    const label = $(strong).text().trim().toLowerCase();
    const value = $(strong).next().text().trim();
    if (label && value) {
      if (label.includes('name')) data.name = value;
      if (label.includes('erwachsene') || label.includes('adults')) data.adults = parseInt(value) || 0;
      if (label.includes('kinder') || label.includes('children')) data.children = parseInt(value) || 0;
      if (label.includes('teilnahme') || th.includes('attending')) {
        data.attending = value.toLowerCase().includes('ja') || value.toLowerCase().includes('yes') ? 1 : 0;
      }
      if (label.includes('kommentar') || label.includes('comments')) data.comments = value;
    }
  });
  
  // If still no name, try to find any text that looks like "Name: ..."
  if (!data.name) {
    const text = $('body').text();
    const nameMatch = text.match(/Name:\s*(.+)/i);
    if (nameMatch) data.name = nameMatch[1].trim();
    const adultsMatch = text.match(/Erwachsene:\s*(\d+)|Adults:\s*(\d+)/i);
    if (adultsMatch) data.adults = parseInt(adultsMatch[1] || adultsMatch[2]) || 0;
    const childrenMatch = text.match(/Kinder:\s*(\d+)|Children:\s*(\d+)/i);
    if (childrenMatch) data.children = parseInt(childrenMatch[1] || childrenMatch[2]) || 0;
    const attendingMatch = text.match(/Teilnahme:\s*(.+)|Attending:\s*(.+)/i);
    if (attendingMatch) {
      const val = (attendingMatch[1] || attendingMatch[2]).toLowerCase();
      data.attending = val.includes('ja') || val.includes('yes') ? 1 : 0;
    }
    const commentsMatch = text.match(/Kommentar:\s*(.+)|Comments:\s*(.+)/i);
    if (commentsMatch) data.comments = (commentsMatch[1] || commentsMatch[2]).trim();
  }
  
  // Defaults
  if (data.attending === undefined) data.attending = 1;
  if (!data.adults) data.adults = 0;
  if (!data.children) data.children = 0;
  
  return data;
}

function isDuplicate(newEntry, existingEntries) {
  // Check if same name and similar timestamp (within 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return existingEntries.some(entry => 
    entry.name.toLowerCase() === newEntry.name.toLowerCase() &&
    new Date(entry.timestamp) > new Date(oneDayAgo)
  );
}

async function fetchEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap(IMAP_CONFIG);
    const newEntries = [];
    
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          reject(err);
          return;
        }
        // Search for RSVP emails from the last 7 days
        const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const searchCriteria = [
          ['SUBJECT', 'Neue RSVP'],
          ['SINCE', sinceDate.toISOString().split('T')[0]]
        ];
        
        imap.search(searchCriteria, (err, results) => {
          if (err) {
            reject(err);
            return;
          }
          if (!results || results.length === 0) {
            console.log('No RSVP emails found.');
            imap.end();
            resolve([]);
            return;
          }
          
          console.log(`Found ${results.length} RSVP emails.`);
          const fetch = imap.fetch(results, { bodies: '' });
          let processed = 0;
          
          fetch.on('message', (msg, seqno) => {
            let body = '';
            msg.on('body', (stream, info) => {
              stream.on('data', chunk => {
                body += chunk.toString('utf8');
              });
            });
            msg.once('end', () => {
              simpleParser(body, (err, parsed) => {
                if (err) {
                  console.error('Email parse error:', err);
                  processed++;
                  if (processed === results.length) imap.end();
                  return;
                }
                const html = parsed.html || '';
                const data = parseEmailHTML(html);
                if (data.name) {
                  const entry = {
                    name: data.name,
                    adults: data.adults,
                    children: data.children,
                    attending: data.attending,
                    comments: data.comments || '',
                    timestamp: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
                    source: 'email'
                  };
                  newEntries.push(entry);
                } else {
                  console.log('Email missing name, skipping. Subject:', parsed.subject);
                }
                processed++;
                if (processed === results.length) imap.end();
              });
            });
          });
          
          fetch.once('error', err => {
            reject(err);
          });
          
          fetch.once('end', () => {
            console.log('IMAP fetch completed.');
          });
        });
      });
    });
    
    imap.once('error', err => {
      reject(err);
    });
    
    imap.once('end', () => {
      console.log('IMAP connection closed.');
      resolve(newEntries);
    });
    
    imap.connect();
  });
}

async function main() {
  try {
    console.log('Starting RSVP email import...');
    const newEntries = await fetchEmails();
    console.log(`Parsed ${newEntries.length} new RSVP entries.`);
    
    // Filter out duplicates
    const uniqueNewEntries = newEntries.filter(entry => !isDuplicate(entry, existingRSVPs));
    console.log(`Adding ${uniqueNewEntries.length} unique new entries.`);
    
    // Merge with existing
    const allEntries = [...existingRSVPs, ...uniqueNewEntries];
    
    // Save to JSON
    fs.writeFileSync(RSVP_JSON_PATH, JSON.stringify(allEntries, null, 2), 'utf8');
    console.log(`Saved ${allEntries.length} total RSVP entries to ${RSVP_JSON_PATH}`);
    
    // Also export CSV for convenience
    const csvHeader = 'Name,Erwachsene,Kinder,Teilnahme (Ja=1),Kommentar,Zeitstempel\n';
    const csvRows = allEntries.map(e => 
      `"${e.name}",${e.adults},${e.children},${e.attending},"${e.comments || ''}",${e.timestamp}`
    ).join('\n');
    fs.writeFileSync(path.join(DATA_DIR, 'rsvp.csv'), csvHeader + csvRows, 'utf8');
    
    // Summary
    const confirmed = allEntries.filter(e => e.attending === 1);
    const declined = allEntries.filter(e => e.attending === 0);
    const totalAdults = confirmed.reduce((sum, e) => sum + e.adults, 0);
    const totalChildren = confirmed.reduce((sum, e) => sum + e.children, 0);
    
    console.log('\n=== SUMMARY ===');
    console.log(`Total RSVPs: ${allEntries.length}`);
    console.log(`Confirmed: ${confirmed.length} (${totalAdults} adults, ${totalChildren} children)`);
    console.log(`Declined: ${declined.length}`);
    
    // Update guestlist (simplified - just output summary for now)
    const summary = {
      totalRSVPs: allEntries.length,
      confirmed: confirmed.length,
      confirmedAdults: totalAdults,
      confirmedChildren: totalChildren,
      declined: declined.length,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(path.join(DATA_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    
    console.log('RSVP import completed successfully.');
    
  } catch (error) {
    console.error('Error during RSVP import:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseEmailHTML, fetchEmails };