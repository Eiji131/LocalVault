// --- IndexedDB Configuration ---
const DB_NAME = 'PasswordVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'passwords';

// --- Global State Variables ---
let db;
let currentPasswords = []; // Holds all passwords currently in the DB
let sortColumn = 'website';
let sortDirection = 'asc';
let isAwaitingConfirmation = false; // Global flag for modal state

// --- Global Edit Modal Element References (Initialized later in initApp) ---
let editModal, editUsernameInput, editPasswordInput, editWebsiteSpan, editEntryIdInput;

/**
 * 1. Opens or creates the IndexedDB database.
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target?.errorCode || event);
            alert("Error opening database. Check console for details.");
            reject(event?.target?.errorCode || event);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("Database opened successfully.");
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                objectStore.createIndex('website', 'website', { unique: false });
                console.log("Object store created.");
            }
        };
    });
}

// ------------------------------------------------------------------
// --- CORE DB OPERATIONS ---
// ------------------------------------------------------------------

/**
 * 2. Retrieves all passwords from the database and updates the global list.
 */
function loadPasswords() {
    if (!db) {
        console.error("Database not initialized.");
        return;
    }

    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = (event) => {
        currentPasswords = event.target.result || [];
        sortAndRenderPasswords(); // Use the sorted version after initial load
    };

    request.onerror = (event) => {
        console.error("Error loading passwords:", event.target.errorCode);
    };
}

/**
 * 3. Adds a new password entry to the database.
 */
function addPassword(entry) {
    if (!db) return;

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.add(entry);

    request.onsuccess = (event) => {
        console.log("Password saved successfully.");
        
        entry.id = event.target.result; // IndexedDB returns the auto-incremented ID
        currentPasswords.push(entry);
        sortAndRenderPasswords(); 
        
        // Clear inputs after successful save
        const websiteEl = document.getElementById('website');
        const usernameEl = document.getElementById('username');
        const passwordEl = document.getElementById('password');
        if (websiteEl) websiteEl.value = '';
        if (usernameEl) usernameEl.value = '';
        if (passwordEl) passwordEl.value = '';
    };

    request.onerror = (event) => {
        console.error("Error saving password:", event.target.errorCode);
        alert("Failed to save password. Check console for details.");
    };
}

/**
 * 4. Deletes a password entry by its unique ID.
 */
function deletePassword(idToDelete) {
    if (!db) return;

    // OPTIMIZATION: Update global array and DOM immediately
    const index = currentPasswords.findIndex(p => p.id === idToDelete);
    if (index !== -1) {
        currentPasswords.splice(index, 1); 
        const row = document.querySelector(`.delete-btn[data-id="${idToDelete}"]`)?.closest('tr');
        if (row) row.remove(); // Remove row from DOM
    }

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(idToDelete);

    request.onsuccess = () => {
        console.log(`Entry with ID ${idToDelete} deleted (Disk write confirmed).`);
    };

    request.onerror = (event) => {
        console.error("Error deleting password:", event.target.errorCode);
        alert("Failed to delete from disk. Reloading data.");
        loadPasswords();
    };
}

/**
 * 7. Updates an existing password entry in the database by its ID.
 */
function updatePassword(entry) {
    if (!db) return;

    // 1. Update the global array immediately 
    const index = currentPasswords.findIndex(p => p.id === entry.id);
    if (index !== -1) {
        currentPasswords[index] = entry;
        updateTableRow(entry); 
    }

    // 2. Start the asynchronous IndexedDB write
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(entry); 

    request.onerror = (event) => {
        console.error("Error updating password:", event.target.errorCode);
        alert("Failed to save changes to disk. Reloading data.");
        loadPasswords(); 
    };
}

// ------------------------------------------------------------------
// --- MODAL & CLEAR ALL LOGIC ---
// ------------------------------------------------------------------

/**
 * Shows the custom modal for clearing all entries.
 */
function clearAllPasswords() {
    if (!db) return;
    
    const modal = document.getElementById('clearModal');
    if (modal) {
        modal.classList.add('show');
        modal.classList.add('d-block');
        isAwaitingConfirmation = true;
    }
}

/**
 * Executes the database clear operation.
 */
function executeClearAll() {
    if (!db) return;

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => {
        console.log("All passwords cleared.");
        
        currentPasswords = [];
        renderPasswords(currentPasswords); 
        
        alert("All saved entries have been permanently deleted from this device.");
    };

    request.onerror = (event) => {
        console.error("Error clearing passwords:", event.target.errorCode);
        alert("Error: Failed to delete passwords from the database.");
    };
}

// ------------------------------------------------------------------
// --- IMPORT/EXPORT LOGIC ---
// ------------------------------------------------------------------

/**
 * Exports all passwords to a JSON file.
 */
function exportPasswords() {
    if (currentPasswords.length === 0) {
        alert("No passwords to export.");
        return;
    }

    const dataStr = JSON.stringify(currentPasswords, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `passwords-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    try {
        link.click();
    } catch (err) {
        window.open(url, '_blank');
    }
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Helper: create an off-screen file input at runtime and trigger it.
 * This avoids relying on a pre-existing hidden input (some browsers/shields block clicks on display:none inputs).
 * onChangeHandler will receive the native input event.
 */
function createAndTriggerFileInput(accept, onChangeHandler) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '';
    // Keep it focusable but off-screen to avoid some browsers blocking programmatic clicks
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    document.body.appendChild(input);

    const cleanup = () => {
        // small timeout to ensure the change event is fully processed
        setTimeout(() => {
            if (input && input.parentNode) input.parentNode.removeChild(input);
        }, 0);
    };

    input.addEventListener('change', (event) => {
        try {
            onChangeHandler(event);
        } finally {
            cleanup();
        }
    }, { once: true });

    // Attempt to open the file dialog. This should be called from a user gesture (button click).
    input.click();
}

/**
 * Handles the import of passwords from a file.
 */
function importPasswordsFromEvent(file, format) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            let importedPasswords;
            if (format === 'json') {
                importedPasswords = JSON.parse(e.target.result);
            } else if (format === 'csv') {
                importedPasswords = parseCSV(e.target.result);
            }

            if (Array.isArray(importedPasswords)) {
                // Basic validation of the imported data
                const validPasswords = importedPasswords.filter(p => p && p.website && p.username && p.password);

                if (validPasswords.length > 0) {
                    const transaction = db.transaction([STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(STORE_NAME);

                    validPasswords.forEach(password => {
                        store.add(password);
                    });

                    transaction.oncomplete = () => {
                        alert(`${validPasswords.length} passwords imported successfully.`);
                        loadPasswords(); // Reload all passwords from the DB
                    };

                    transaction.onerror = (event) => {
                        console.error("Error importing passwords:", event.target.errorCode);
                        alert("An error occurred during the import process.");
                    };
                } else {
                    alert("No valid password entries found in the file.");
                }
            } else {
                alert("Invalid file format. Please select a valid " + format.toUpperCase() + " file.");
            }
        } catch (error) {
            console.error("Error parsing file:", error);
            alert("Error reading or parsing the file. Make sure it is a valid " + format.toUpperCase() + " file.");
        }
    };
    reader.readAsText(file);
}

/**
 * Parses a CSV string into an array of password objects.
 * Robust basic CSV parser: handles CRLF/LF, quoted fields, and escaped quotes.
 */
function parseCSV(csv) {
    if (!csv) return [];

    // Normalize line endings
    const normalized = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Split but keep empty lines for potential quoted newlines handling later; we'll filter empty rows after parse
    const lines = normalized.split('\n');

    // A parser that handles quoted fields and commas inside quotes
    const parseRow = (row) => {
        const fields = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (row[i + 1] === '"') { // escaped quote
                        cur += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    cur += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === ',') {
                    fields.push(cur);
                    cur = '';
                } else {
                    cur += ch;
                }
            }
        }
        fields.push(cur);
        return fields;
    };

    // find first non-empty line as header (skip empty or whitespace-only lines)
    let headerLineIndex = 0;
    while (headerLineIndex < lines.length && lines[headerLineIndex].trim() === '') headerLineIndex++;
    if (headerLineIndex >= lines.length) return [];

    const headers = parseRow(lines[headerLineIndex]).map(h => h.trim());
    const passwords = [];

    for (let i = headerLineIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue; // skip empty lines
        const values = parseRow(line);
        if (values.length === headers.length) {
            const obj = {};
            for (let j = 0; j < headers.length; j++) {
                obj[headers[j]] = values[j];
            }
            passwords.push(obj);
        } else {
            // If a line didn't match header length, attempt to join subsequent lines (rare) or skip and log
            console.warn('Skipped malformed CSV line (column mismatch):', line);
        }
    }

    return passwords;
}

/**
 * Escapes a CSV cell value per RFC4180 and returns a string.
 */
function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/**
 * Exports all passwords to a CSV file (more robust quoting).
 */
function exportToCSV() {
    if (currentPasswords.length === 0) {
        alert("No passwords to export.");
        return;
    }

    const headers = ['website', 'username', 'password'];
    const csvRows = [];
    csvRows.push(headers.join(','));
    currentPasswords.forEach(row => {
        const r = headers.map(fieldName => csvEscape(row[fieldName]));
        csvRows.push(r.join(','));
    });
    const csv = csvRows.join('\r\n');

    const dataBlob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `passwords-backup-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);

    try {
        link.click();
    } catch (err) {
        // fallback: open the blob URL in a new tab so user can manually save it
        window.open(url, '_blank');
    }

    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}


// ------------------------------------------------------------------
// --- EDIT MODAL LOGIC (MAJOR REWORK) ---
// ------------------------------------------------------------------

/**
 * 8. Populates the Edit Modal with the entry's current data and displays it.
 */
function editEntry(idToEdit) {
    const entry = currentPasswords.find(p => p.id === idToEdit);
    if (!entry || !editModal) {
        alert("Error: Entry not found or Edit Modal not initialized.");
        return;
    }

    editWebsiteSpan.textContent = entry.website;
    editUsernameInput.value = entry.username;
    editPasswordInput.value = entry.password;
    editEntryIdInput.value = entry.id;

    editPasswordInput.type = 'password';
    const toggleIcon = document.getElementById('toggleEditPassword')?.querySelector('i');
    if (toggleIcon) {
        toggleIcon.classList.remove('fa-eye-slash');
        toggleIcon.classList.add('fa-eye');
    }

    editModal.classList.add('show');
    editModal.classList.add('d-block');
}

// ------------------------------------------------------------------
// --- UI & UTILITY FUNCTIONS ---
// ------------------------------------------------------------------

/**
 * Utility function to update a single row in the table (DOM).
 */
function updateTableRow(entry) {
    const passwordSpan = document.querySelector(`.password-display[data-id="${entry.id}"]`);
    if (!passwordSpan) return;

    const row = passwordSpan.closest('tr');
    if (!row) return;

    // Cells are 0-indexed: [0: Website, 1: Username, 2: Password, 3: Actions]
    row.cells[1].textContent = entry.username;
    
    // Reset the Password cell to masked
    const maskedPassword = '*'.repeat(entry.password.length);
    passwordSpan.textContent = maskedPassword;
    passwordSpan.style.color = '#007bff'; 
}

/**
 * Function to display the list of passwords in a TABLE structure (Uses data-label for responsiveness).
 */
function renderPasswords(passwords) {
    const tableBody = document.getElementById('passwordTableBody');
    if (!tableBody) return;
    tableBody.innerHTML = ''; 

    if (!passwords || passwords.length === 0) {
        const emptyRow = tableBody.insertRow();
        const cell = emptyRow.insertCell();
        cell.colSpan = 4;
        cell.style.textAlign = 'center';
        cell.innerHTML = 'No passwords saved yet. Start by adding one above!';
        return;
    }

    passwords.forEach((entry) => {
        const row = tableBody.insertRow();
        const maskedPassword = '*'.repeat((entry.password || '').length);

        // 1. Website Cell 
        const websiteCell = row.insertCell();
        websiteCell.textContent = entry.website || '';
        websiteCell.setAttribute('data-label', 'Website');

        // 2. Username Cell
        const usernameCell = row.insertCell();
        usernameCell.textContent = entry.username || '';
        usernameCell.setAttribute('data-label', 'Username');

        // 3. Password Cell (Interactive)
        const passwordCell = row.insertCell();
        passwordCell.innerHTML = `<span class="password-display" data-id="${entry.id}">${maskedPassword}</span>`;
        passwordCell.style.cursor = 'pointer';
        passwordCell.setAttribute('data-label', 'Password');

        // 4. Actions Cell (Edit and Delete Buttons)
        const actionsCell = row.insertCell();
        actionsCell.className = 'action-cell';
        actionsCell.innerHTML = `
            <button class="btn btn-sm btn-outline-primary edit-btn" data-id="${entry.id}" data-bs-toggle="tooltip" title="Edit">
                <i class="fas fa-pencil-alt"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger delete-btn" data-id="${entry.id}" data-bs-toggle="tooltip" title="Delete">
                <i class="fas fa-trash-alt"></i>
            </button>
        `;
        actionsCell.setAttribute('data-label', 'Actions'); 
    });

    // --- Attach Listeners to newly created table rows ---
    tableBody.querySelectorAll('.password-display').forEach(span => {
        span.addEventListener('click', function() {
            const id = parseInt(this.getAttribute('data-id'));
            const entry = currentPasswords.find(p => p.id === id); 
            if (entry) {
                 togglePasswordVisibility(this, entry.password);
            }
        });
    });

    tableBody.querySelectorAll('.edit-btn').forEach(button => {
        button.addEventListener('click', function() {
             const idToEdit = parseInt(this.getAttribute('data-id'));
             editEntry(idToEdit);
        });
    });

    tableBody.querySelectorAll('.delete-btn').forEach(button => {
        button.addEventListener('click', function() {
             const idToDelete = parseInt(this.getAttribute('data-id'));
             deletePassword(idToDelete);
        });
    });
}

/**
 * Filters the currentPasswords array based on the search term.
 * @param {string} searchTerm 
 */
function filterPasswords(searchTerm) {
    const term = (searchTerm || '').toLowerCase().trim();
    
    if (term === '') {
        sortAndRenderPasswords();
        return;
    }

    const filteredList = currentPasswords.filter(entry => 
        (entry.website || '').toLowerCase().includes(term) ||
        (entry.username || '').toLowerCase().includes(term)
    );

    renderPasswords(filteredList);
}

/**
 * Function to toggle saved password visibility in the table.
 */
function togglePasswordVisibility(spanElement, realPassword) {
    if (!spanElement) return;
    if ((spanElement.textContent || '').includes('*')) {
        spanElement.textContent = realPassword;
        spanElement.style.color = 'red';
    } else {
        spanElement.textContent = '*'.repeat((realPassword || '').length);
        spanElement.style.color = '#007bff';
    }
}

/**
 * Handles table sorting logic.
 */
function sortAndRenderPasswords() {
    // Ensure values are strings before comparing
    currentPasswords.sort((a, b) => {
        const valA = ((a[sortColumn] || '') + '').toLowerCase();
        const valB = ((b[sortColumn] || '') + '').toLowerCase();

        let comparison = 0;
        if (valA > valB) { comparison = 1; } 
        else if (valA < valB) { comparison = -1; }

        return sortDirection === 'desc' ? comparison * -1 : comparison;
    });

    // Re-render the table with the sorted data
    renderPasswords(currentPasswords);
}

// ------------------------------------------------------------------
// --- EVENT LISTENER SETUP (moved inside init to avoid DOM timing issues) ---
// ------------------------------------------------------------------
function setupEventListeners() {
    // Save Button
    const saveButton = document.getElementById('saveButton');
    if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Password';
        saveButton.addEventListener('click', function() {
            if (!db) {
                alert('Database is still loading. Please wait a moment and try again.');
                return; 
            }
            
            const website = document.getElementById('website')?.value.trim();
            const username = document.getElementById('username')?.value.trim();
            const password = document.getElementById('password')?.value;

            if (website && username && password) {
                const newEntry = { website, username, password, createdAt: new Date() };
                addPassword(newEntry);
            } else {
                alert('Please fill out all fields.');
            }
        });
    }

    // Clear Button
    const clearButton = document.getElementById('clearButton');
    if (clearButton) clearButton.addEventListener('click', clearAllPasswords);

    // Toggle password input visibility on add form
    const togglePassword = document.getElementById('togglePassword');
    if (togglePassword) {
        togglePassword.addEventListener('click', function(event) {
            event.preventDefault(); 
            const passwordInput = document.getElementById('password');
            if (!passwordInput) return;
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                this.textContent = 'Hide';
            } else {
                passwordInput.type = 'password';
                this.textContent = 'Show';
            }
        });
    }

    // Table header sorting
    const passwordTable = document.getElementById('passwordTable');
    if (passwordTable) {
        passwordTable.addEventListener('click', function(event) {
            const target = event.target;
            if (target && target.tagName === 'TH') {
                const newSortColumn = target.getAttribute('data-sort');
                if (!newSortColumn) return;
                
                if (newSortColumn === sortColumn) {
                    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    sortColumn = newSortColumn;
                    sortDirection = 'asc';
                }
                
                sortAndRenderPasswords();
            }
        });
    }

    // Search bar
    const searchBar = document.getElementById('searchBar');
    if (searchBar) {
        searchBar.addEventListener('keyup', function() {
            filterPasswords(this.value);
        });
    }

    // Clear modal buttons (confirm/cancel) - ensure modal elements are present
    const clearModal = document.getElementById('clearModal');
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');

    function hideClearModal() {
        if (clearModal) {
            clearModal.classList.remove('show');
            clearModal.classList.remove('d-block');
            isAwaitingConfirmation = false;
        }
    }

    if (clearModal && modalConfirm && modalCancel) {
        modalConfirm.addEventListener('click', function() {
            if (isAwaitingConfirmation) {
                executeClearAll(); 
                hideClearModal();
            }
        });
        modalCancel.addEventListener('click', hideClearModal);
        const btnClose = clearModal.querySelector('.btn-close');
        if (btnClose) btnClose.addEventListener('click', hideClearModal);
    }

    // Edit modal elements
    editModal = document.getElementById('editModal');
    editUsernameInput = document.getElementById('editUsername');
    editPasswordInput = document.getElementById('editPassword');
    editWebsiteSpan = document.getElementById('editModalWebsite');
    editEntryIdInput = document.getElementById('editEntryId');
    const editSaveButton = document.getElementById('editSave');
    const editCancelButton = document.getElementById('editCancel');
    const toggleEditPasswordButton = document.getElementById('toggleEditPassword');
    const editCloseButton = editModal ? editModal.querySelector('.btn-close') : null;
    
    function hideEditModal() {
        if(editModal) {
            editModal.classList.remove('show');
            editModal.classList.remove('d-block');
        }
    }

    // A. Password Toggle Listener for Edit Modal
    if (toggleEditPasswordButton) {
        toggleEditPasswordButton.addEventListener('click', function(event) {
            event.preventDefault(); 
            const icon = this.querySelector('i');
            if (!editPasswordInput) return;
            if (editPasswordInput.type === 'password') {
                editPasswordInput.type = 'text';
                if (icon) { icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); }
            } else {
                editPasswordInput.type = 'password';
                if (icon) { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
            }
        });
    }

    // B. Save Changes Listener
    if (editSaveButton) {
        editSaveButton.addEventListener('click', function() {
            const id = parseInt(editEntryIdInput.value);
            const originalEntry = currentPasswords.find(p => p.id === id);
            
            if (!originalEntry) {
                alert("Error: Entry ID not found for saving.");
                return;
            }

            const newUsername = editUsernameInput.value.trim();
            const newPassword = editPasswordInput.value;
            
            // Check if values were actually changed
            if (newUsername === originalEntry.username && newPassword === originalEntry.password) {
                alert("No changes were made.");
                hideEditModal();
                return;
            }
            
            if (newUsername && newPassword) {
                const updatedEntry = {
                    ...originalEntry, 
                    username: newUsername,
                    password: newPassword,
                };
                updatePassword(updatedEntry);
                hideEditModal();
            } else {
                alert("Username and Password cannot be empty.");
            }
        });
    }
    
    // C. Cancel/Close Listeners
    if (editCancelButton) editCancelButton.addEventListener('click', hideEditModal);
    if (editCloseButton) editCloseButton.addEventListener('click', hideEditModal); // X button
    
    // D. Global Click Listener to close ANY open modal when clicking the backdrop
    window.addEventListener('click', function(event) {
        if (event.target.classList && event.target.classList.contains('modal')) {
            if (clearModal) hideClearModal();
            if (editModal) hideEditModal();
        }
    });

    // --- IMPORT/EXPORT BUTTONS ---
    const importButton = document.getElementById('importButton');
    const exportButton = document.getElementById('exportButton');
    const csvImportButton = document.getElementById('csvImportButton');
    const csvExportButton = document.getElementById('csvExportButton');

    if (importButton) {
        importButton.addEventListener('click', () => {
            // create input dynamically to avoid Brave/extension blocking issues with hidden inputs
            createAndTriggerFileInput('.json', (ev) => {
                const file = ev.target.files && ev.target.files[0];
                importPasswordsFromEvent(file, 'json');
            });
        });
    }

    if (csvImportButton) {
        csvImportButton.addEventListener('click', () => {
            createAndTriggerFileInput('.csv', (ev) => {
                const file = ev.target.files && ev.target.files[0];
                importPasswordsFromEvent(file, 'csv');
            });
        });
    }

    if (exportButton) {
        exportButton.addEventListener('click', exportPasswords);
    }

    if (csvExportButton) {
        csvExportButton.addEventListener('click', exportToCSV);
    }
}

// ------------------------------------------------------------------
// --- INITIALIZATION & DB OPENING ---
// ------------------------------------------------------------------

function initApp() {
    // open DB first, then setup UI and listeners
    openDB()
        .then(() => {
            setupEventListeners();
            loadPasswords();
        })
        .catch(err => {
            console.error("Failed to initialize application:", err);
            alert("Initialization failed. Check the console for details.");
        });
}

// Use DOMContentLoaded so the script can be loaded in head safely
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
} else {
    // already loaded
    initApp();
}
