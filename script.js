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
// Toast instance for legacy saveToast (not used now). We'll use dynamic toasts instead.
let saveToastInstance = null;
let lastDeletedEntry = null; // cached for undo
let deferredPrompt; // PWA install prompt

// Listen for PWA install event
window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    deferredPrompt = e;
    // Show the install button
    const btn = document.getElementById('installAppBtn');
    if (btn) btn.style.display = 'block';
});

window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const btn = document.getElementById('installAppBtn');
    if (btn) btn.style.display = 'none';
});

/** Create a dynamic Bootstrap toast and show it. Returns the Toast instance. */
function createDynamicToast(message, variant = 'success', options = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) {
        // fallback to showToast which will create ephemeral box
        showToast(message, variant);
        return null;
    }

    // Build toast element
    const toastEl = document.createElement('div');
    toastEl.className = `toast align-items-center text-bg-${variant} border-0 mb-2`;
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
    toastEl.setAttribute('aria-atomic', 'true');

    // content (allow optional action button)
    const inner = document.createElement('div');
    inner.className = 'd-flex';

    const body = document.createElement('div');
    body.className = 'toast-body';
    body.innerHTML = options.html ? (options.htmlContent || message) : message;
    inner.appendChild(body);

    if (options.action) {
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'btn btn-sm btn-light ms-2';
        actionBtn.innerHTML = options.action.label || 'Undo';
        actionBtn.addEventListener('click', options.action.onClick);
        inner.appendChild(actionBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-close btn-close-white me-2 m-auto';
    closeBtn.setAttribute('data-bs-dismiss', 'toast');
    closeBtn.setAttribute('aria-label', 'Close');
    inner.appendChild(closeBtn);

    toastEl.appendChild(inner);
    container.appendChild(toastEl);

    try {
        const toast = new bootstrap.Toast(toastEl, { delay: options.delay || 4000 });
        toast.show();
        // remove from DOM after hidden
        toastEl.addEventListener('hidden.bs.toast', () => { toastEl.remove(); });
        return toast;
    } catch (e) {
        console.warn('Failed to create bootstrap toast', e);
        // fallback ephemeral
        showToast(message, variant);
        return null;
    }
}

/**
 * Show a toast notification. Uses Bootstrap toast if initialized, otherwise falls back to a small ephemeral DOM node.
 * @param {string} message
 * @param {'success'|'danger'|'info'} variant
 */
function showToast(message, variant = 'success') {
    try {
        const toastEl = document.getElementById('saveToast');
        if (toastEl && window.bootstrap && saveToastInstance) {
            // Update text and background
            const body = toastEl.querySelector('.toast-body');
            if (body) body.textContent = message;
            // reset classes then add variant
            toastEl.classList.remove('text-bg-success', 'text-bg-danger', 'text-bg-info');
            toastEl.classList.add(variant === 'danger' ? 'text-bg-danger' : variant === 'info' ? 'text-bg-info' : 'text-bg-success');
            saveToastInstance.show();
            return;
        }
    } catch (err) {
        console.warn('Bootstrap toast show failed', err);
    }

    // Fallback ephemeral notice
    const fallback = document.createElement('div');
    fallback.textContent = message;
    fallback.style.position = 'fixed';
    fallback.style.right = '20px';
    fallback.style.top = '20px';
    fallback.style.background = variant === 'danger' ? '#dc3545' : (variant === 'info' ? '#17a2b8' : '#28a745');
    fallback.style.color = 'white';
    fallback.style.padding = '8px 12px';
    fallback.style.borderRadius = '6px';
    fallback.style.zIndex = '2000';
    document.body.appendChild(fallback);
    setTimeout(() => fallback.remove(), 2000);
}

/**
 * Shows a small ephemeral notification directly above the Save button.
 * Used when user presses Enter or clicks Save with empty required fields.
 */
function showInlineToastOverSave(message, variant = 'warning') {
    const saveButton = document.getElementById('saveButton');
    if (!saveButton) {
        // fallback to dynamic toasts if save button not found
        createDynamicToast(message, variant, { delay: 2000 });
        return;
    }

    // Create element
    const el = document.createElement('div');
    el.className = 'inline-toast p-2 rounded text-white d-inline-block';
    el.style.position = 'absolute';
    el.style.zIndex = '2000';
    el.style.pointerEvents = 'none';
    el.style.opacity = '1';
    el.style.transition = 'opacity 0.25s ease';
    el.style.fontSize = '0.9rem';
    el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';

    // Background color based on variant
    if (variant === 'danger') el.style.background = '#dc3545';
    else if (variant === 'success') el.style.background = '#28a745';
    else if (variant === 'info') el.style.background = '#17a2b8';
    else el.style.background = '#ffc107'; // warning

    el.textContent = message;

    document.body.appendChild(el);

    // Position it centered above the save button
    const rect = saveButton.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    const elWidth = el.offsetWidth;
    const left = rect.left + scrollX + Math.round((rect.width - elWidth) / 2);
    const top = rect.top + scrollY - el.offsetHeight - 10; // 10px gap above

    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;

    // Auto-dismiss after a short delay
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }, 2000);
}

// --- Global Edit Modal Element References (Initialized later in initApp) ---
let editModal, editUsernameInput, editPasswordInput, editWebsiteInput, editEntryIdInput;

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
        if (passwordEl) {
            passwordEl.value = '';
            // reset color in case it was revealed
            passwordEl.style.color = '';
            passwordEl.type = 'password';
            const toggleEl = document.getElementById('togglePassword');
            if (toggleEl) toggleEl.textContent = 'Show';
        }
        // Show a success toast notification including the website name
        try {
            const message = `Saved: ${entry.website}`;
            createDynamicToast(message, 'success', { delay: 2500 });
        } catch (e) {
            console.warn('Toast show failed', e);
        }
    };

    request.onerror = (event) => {
        console.error("Error saving password:", event.target.errorCode);
        alert("Failed to save password. Check console for details.");
    };
}

/**
 * Perform the save action (used by Save button and Enter key).
 */
function performSave() {
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
        // Show a small, non-blocking notification above the Save button
        showInlineToastOverSave('Please fill out all fields.', 'warning');
    }
}

/**
 * 4. Deletes a password entry by its unique ID.
 */
function deletePassword(idToDelete) {
    if (!db) return;

    // OPTIMIZATION: Update global array and DOM immediately
    const index = currentPasswords.findIndex(p => p.id === idToDelete);
    let deletedEntry = null;
    if (index !== -1) {
        // cache for undo
        deletedEntry = currentPasswords[index];
        currentPasswords.splice(index, 1); 
        const row = document.querySelector(`.delete-btn[data-id="${idToDelete}"]`)?.closest('tr');
        if (row) row.remove(); // Remove row from DOM
    }

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(idToDelete);

    request.onsuccess = () => {
        console.log(`Entry with ID ${idToDelete} deleted (Disk write confirmed).`);
        // Notify user with Undo option
        lastDeletedEntry = deletedEntry;
        createDynamicToast(`Deleted: ${deletedEntry ? deletedEntry.website : 'entry'}`, 'danger', {
            delay: 6000,
            action: {
                label: 'Undo',
                onClick: function() {
                    if (!lastDeletedEntry) return;
                    const toRestore = { ...lastDeletedEntry };
                    // re-add to DB; will get a new id
                    addPassword({ website: toRestore.website, username: toRestore.username, password: toRestore.password, createdAt: new Date() });
                    lastDeletedEntry = null;
                }
            }
        });
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

    request.onsuccess = () => {
        console.log(`Entry with ID ${entry.id} updated (Disk write confirmed).`);
        try {
            createDynamicToast(`Updated: ${entry.website}`, 'success', { delay: 2500 });
        } catch (e) {
            console.warn('Toast show failed', e);
        }
    };

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

// Security constants
const MIN_ENCRYPTION_PASSWORD_LENGTH = 12;
const MAX_DECRYPTION_ATTEMPTS = 5;
const DECRYPTION_LOCKOUT_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds

// Global state for pending import/export operations
let pendingImportFile = null;
let pendingExportPassword = null;
let decryptionAttempts = 0;
let lastDecryptionAttemptTime = 0;
let isDecryptionLocked = false;

/**
 * Encrypts data using CryptoJS AES encryption
 * @param {string} data - The data to encrypt (JSON string)
 * @param {string} password - The encryption password
 * @returns {string} - Encrypted data (cipher text)
 */
function encryptData(data, password) {
    try {
        const encrypted = CryptoJS.AES.encrypt(data, password).toString();
        return encrypted;
    } catch (error) {
        console.error("Encryption error:", error);
        throw new Error("Failed to encrypt data");
    }
}

/**
 * Decrypts data using CryptoJS AES decryption
 * @param {string} encryptedData - The encrypted data
 * @param {string} password - The decryption password
 * @returns {string} - Decrypted data (JSON string)
 */
function decryptData(encryptedData, password) {
    try {
        const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
        if (!decrypted) {
            throw new Error("Decryption failed - incorrect password or corrupted data");
        }
        return decrypted;
    } catch (error) {
        console.error("Decryption error:", error);
        throw new Error("Failed to decrypt data - incorrect password or corrupted file");
    }
}

/**
 * Validates encryption password
 * @param {string} password - The password to validate
 * @returns {object} - { valid: boolean, message: string }
 */
function validateEncryptionPassword(password) {
    if (!password || password.length < MIN_ENCRYPTION_PASSWORD_LENGTH) {
        return {
            valid: false,
            message: `Password must be at least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters long`
        };
    }
    return { valid: true, message: "Password is valid" };
}

/**
 * Checks and enforces rate limiting for decryption attempts
 * @returns {object} - { allowed: boolean, message: string, remainingTime: number }
 */
function checkDecryptionRateLimit() {
    const now = Date.now();
    
    // Check if currently locked
    if (isDecryptionLocked) {
        const timeSinceLock = now - lastDecryptionAttemptTime;
        if (timeSinceLock < DECRYPTION_LOCKOUT_TIME) {
            const remainingSeconds = Math.ceil((DECRYPTION_LOCKOUT_TIME - timeSinceLock) / 1000);
            return {
                allowed: false,
                message: `Too many failed attempts. Please wait ${remainingSeconds} seconds.`,
                remainingTime: remainingSeconds
            };
        } else {
            // Lockout period has expired
            isDecryptionLocked = false;
            decryptionAttempts = 0;
            lastDecryptionAttemptTime = 0;
        }
    }
    
    return { allowed: true, message: "Rate limit check passed", remainingTime: 0 };
}

/**
 * Records a failed decryption attempt and applies rate limiting if needed
 */
function recordFailedDecryptionAttempt() {
    decryptionAttempts++;
    lastDecryptionAttemptTime = Date.now();
    
    if (decryptionAttempts >= MAX_DECRYPTION_ATTEMPTS) {
        isDecryptionLocked = true;
    }
}

/**
 * Updates the decryption attempt warning display
 */
function updateDecryptionAttemptWarning() {
    const warningEl = document.getElementById('decryptionAttemptWarning');
    if (!warningEl) return;
    
    if (decryptionAttempts > 0 && decryptionAttempts < MAX_DECRYPTION_ATTEMPTS) {
        const remainingAttempts = MAX_DECRYPTION_ATTEMPTS - decryptionAttempts;
        warningEl.textContent = `⚠️ ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining before lockout`;
        warningEl.style.display = 'block';
    } else {
        warningEl.style.display = 'none';
    }
}

/**
 * Resets decryption attempt counter
 */
function resetDecryptionAttempts() {
    decryptionAttempts = 0;
    isDecryptionLocked = false;
    lastDecryptionAttemptTime = 0;
    updateDecryptionAttemptWarning();
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
 * Checks if a password entry with the same website, username, and password already exists.
 * @param {object} entry The password entry to check.
 * @returns {boolean} True if a duplicate exists, false otherwise.
 */
function isDuplicate(entry) {
    return currentPasswords.some(existingEntry =>
        existingEntry.website === entry.website &&
        existingEntry.username === entry.username &&
        existingEntry.password === entry.password
    );
}

/**
 * Handles the import of passwords from a file with decryption if needed.
 */
function importPasswordsFromEvent(file, format) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            let importedPasswords;
            const fileContent = e.target.result;

            if (format === 'secured') {
                // Check if the file is encrypted by looking for CryptoJS marker
                if (fileContent.includes('U2FsdGVkX1')) {
                    // File appears to be encrypted, store it and show decryption modal
                    pendingImportFile = fileContent;
                    const decryptionModal = new bootstrap.Modal(document.getElementById('decryptionModal'));
                    decryptionModal.show();
                    return;
                } else {
                    // File is not encrypted, parse directly
                    importedPasswords = JSON.parse(fileContent);
                }
            } else {
                alert("Invalid file format. Please select a valid .secured file.");
                return;
            }

            // Process the imported passwords
            processImportedPasswords(importedPasswords);
        } catch (error) {
            console.error("Error parsing file:", error);
            alert("Error reading or parsing the file. Make sure it is a valid .secured file.");
        }
    };
    reader.readAsText(file);
}

/**
 * Processes imported passwords and adds them to the database
 * @param {array} importedPasswords - Array of password entries to import
 */
function processImportedPasswords(importedPasswords) {
    if (Array.isArray(importedPasswords)) {
        // Basic validation of the imported data
        const validPasswords = importedPasswords.filter(p => p && p.website && p.username && p.password);

        let uniquePasswordsToImport = [];
        let duplicatesSkipped = 0;

        validPasswords.forEach(password => {
            if (!isDuplicate(password)) {
                uniquePasswordsToImport.push(password);
            } else {
                duplicatesSkipped++;
            }
        });

        if (uniquePasswordsToImport.length > 0) {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            uniquePasswordsToImport.forEach(password => {
                store.add(password);
            });

            transaction.oncomplete = () => {
                let message = `${uniquePasswordsToImport.length} passwords imported successfully.`;
                if (duplicatesSkipped > 0) {
                    message += ` ${duplicatesSkipped} duplicates skipped.`;
                }
                createDynamicToast(message, 'success');
                loadPasswords(); // Reload all passwords from the DB
            };

            transaction.onerror = (event) => {
                console.error("Error importing passwords:", event.target.errorCode);
                createDynamicToast("An error occurred during the import process.", 'danger');
            };
        } else if (duplicatesSkipped > 0) {
            createDynamicToast(`${duplicatesSkipped} duplicates skipped. No new passwords imported.`, 'warning');
        } else {
            createDynamicToast("No valid password entries found in the file.", 'warning');
        }
    } else {
        createDynamicToast("Invalid file format. Please select a valid .secured file.", 'danger');
    }
}

/**
 * Exports all passwords to a Secured file (JSON content).
 * Prompts for encryption password first.
 */
function exportToSecured() {
    if (currentPasswords.length === 0) {
        createDynamicToast("No passwords to export.", 'warning');
        return;
    }

    // Show encryption password modal
    const encryptionModal = new bootstrap.Modal(document.getElementById('encryptionModal'));
    encryptionModal.show();
}

/**
 * Completes the export process with encryption
 * @param {string} password - The encryption password
 */
function completeEncryptedExport(password) {
    try {
        // Create the data to export
        const dataStr = JSON.stringify(currentPasswords, null, 2);
        
        // Encrypt the data
        const encryptedData = encryptData(dataStr, password);
        
        // Create and download the file
        const dataBlob = new Blob([encryptedData], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `passwords-backup-${new Date().toISOString().split('T')[0]}.secured`;
        document.body.appendChild(link);

        try {
            link.click();
            createDynamicToast("Passwords exported successfully!", 'success');
        } catch (err) {
            // fallback: open the blob URL in a new tab so user can manually save it
            window.open(url, '_blank');
            createDynamicToast("Passwords exported successfully! (opened in new tab)", 'success');
        }

        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error("Export error:", error);
        createDynamicToast("Failed to export passwords: " + error.message, 'danger');
    }
}

/**
 * Completes the import process with decryption
 * @param {string} password - The decryption password
 */
function completeDecryptedImport(password) {
    try {
        if (!pendingImportFile) {
            createDynamicToast("No file to import.", 'danger');
            return;
        }

        // Decrypt the data
        const decryptedData = decryptData(pendingImportFile, password);
        
        // Parse and process the decrypted data
        const importedPasswords = JSON.parse(decryptedData);
        processImportedPasswords(importedPasswords);
        
        // Clear the pending import file
        pendingImportFile = null;
    } catch (error) {
        console.error("Import error:", error);
        createDynamicToast("Failed to import passwords: " + error.message, 'danger');
    }
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

    editWebsiteInput.value = entry.website;
    editUsernameInput.value = entry.username;
    editPasswordInput.value = entry.password;
    editEntryIdInput.value = entry.id;

    // Ensure hidden and default color when opening
    editPasswordInput.type = 'password';
    editPasswordInput.style.color = ''; // reset any previous reveal color
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
    row.cells[0].textContent = entry.website;
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
            <button class="btn btn-sm btn-outline-secondary copy-user-btn" data-id="${entry.id}" data-bs-toggle="tooltip" title="Copy Username">
                <i class="fas fa-clipboard"></i>
            </button>
            <button class="btn btn-sm btn-outline-secondary copy-btn ms-1" data-id="${entry.id}" data-bs-toggle="tooltip" title="Copy Password">
                <i class="fas fa-copy"></i>
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

    // Copy button listeners (copies the real password to clipboard)
    tableBody.querySelectorAll('.copy-btn').forEach(button => {
        button.addEventListener('click', function(event) {
            event.stopPropagation();
            const id = parseInt(this.getAttribute('data-id'));
            const entry = currentPasswords.find(p => p.id === id);
            if (!entry) return;

            const btn = this;
            const originalHTML = btn.innerHTML;

            // attempt navigator.clipboard first
            const copyText = entry.password || '';
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(copyText).then(() => {
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => btn.innerHTML = originalHTML, 1200);
                }).catch(err => {
                    // fallback to older execCommand
                    fallbackCopyTextToClipboard(copyText, btn, originalHTML);
                });
            } else {
                fallbackCopyTextToClipboard(copyText, btn, originalHTML);
            }
        });
    });

    // Copy username listeners (copies the username to clipboard)
    tableBody.querySelectorAll('.copy-user-btn').forEach(button => {
        button.addEventListener('click', function(event) {
            event.stopPropagation();
            const id = parseInt(this.getAttribute('data-id'));
            const entry = currentPasswords.find(p => p.id === id);
            if (!entry) return;

            const btn = this;
            const originalHTML = btn.innerHTML;
            const copyText = entry.username || '';

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(copyText).then(() => {
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => btn.innerHTML = originalHTML, 1200);
                }).catch(err => {
                    fallbackCopyTextToClipboard(copyText, btn, originalHTML);
                });
            } else {
                fallbackCopyTextToClipboard(copyText, btn, originalHTML);
            }
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
        // Make revealed password green
        spanElement.style.color = '#28a745';
    } else {
        spanElement.textContent = '*'.repeat((realPassword || '').length);
        // Restore masked color
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
        // clicking Save runs the shared performSave() routine
        saveButton.addEventListener('click', performSave);

        // Also trigger save when the user presses Enter inside any of the inputs
        const websiteInput = document.getElementById('website');
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');
        const _onEnter = (evt) => {
            if (!evt) return;
            if (evt.key === 'Enter') {
                evt.preventDefault();
                performSave();
            }
        };
        if (websiteInput) websiteInput.addEventListener('keydown', _onEnter);
        if (usernameInput) usernameInput.addEventListener('keydown', _onEnter);
        if (passwordInput) passwordInput.addEventListener('keydown', _onEnter);
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
                // Make revealed password green
                passwordInput.style.color = '#28a745';
            } else {
                passwordInput.type = 'password';
                this.textContent = 'Show';
                // Reset color when hidden
                passwordInput.style.color = '';
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
    const clearSearchButton = document.getElementById('clearSearchButton');
    if (searchBar) {
        searchBar.addEventListener('input', function() {
            filterPasswords(this.value);
            if (clearSearchButton) {
                if (this.value.length > 0) {
                    clearSearchButton.style.display = 'block';
                } else {
                    clearSearchButton.style.display = 'none';
                }
            }
        });
    }

    // Clear Search Button
    if (clearSearchButton) {
        clearSearchButton.addEventListener('click', function() {
            if (searchBar) {
                searchBar.value = '';
                filterPasswords('');
                clearSearchButton.style.display = 'none';
            }
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

    // Initialize save toast (Bootstrap) if present
    const saveToastEl = document.getElementById('saveToast');
    if (saveToastEl && window.bootstrap) {
        try {
            saveToastInstance = new bootstrap.Toast(saveToastEl, { delay: 2000 });
        } catch (e) {
            console.warn('Failed to init save toast', e);
            saveToastInstance = null;
        }
    }

    // Initialize a popover on the navbar brand that explains local-only storage
    const brandEl = document.getElementById('brand');
    function initBrandPopover() {
        if (!brandEl) return;
        try {
            if (window.bootstrap) {
                // If not already initialized, create a popover instance
                const existing = bootstrap.Popover.getInstance(brandEl);
                if (!existing) {
                    new bootstrap.Popover(brandEl, { trigger: 'hover focus', placement: 'bottom', html: false });
                }
            }
        } catch (err) {
            console.warn('Brand popover init failed', err);
        }
    }

    // Try to init immediately if possible, otherwise when window finishes loading
    if (window.bootstrap) initBrandPopover();
    else window.addEventListener('load', initBrandPopover);

    // Edit modal elements
    editModal = document.getElementById('editModal');
    editWebsiteInput = document.getElementById('editWebsite'); // NEW: Initialize editWebsiteInput
    editUsernameInput = document.getElementById('editUsername');
    editPasswordInput = document.getElementById('editPassword');
    // editWebsiteSpan removed as it's no longer used for displaying website in title
    editEntryIdInput = document.getElementById('editEntryId');
    const editSaveButton = document.getElementById('editSave');
    const editCancelButton = document.getElementById('editCancel');
    const toggleEditPasswordButton = document.getElementById('toggleEditPassword');
    const editCloseButton = editModal ? editModal.querySelector('.btn-close') : null;
    
    // Allow Enter key to trigger Save in Edit Modal
    if (editSaveButton) {
        [editWebsiteInput, editUsernameInput, editPasswordInput].forEach(input => {
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        editSaveButton.click();
                    }
                });
            }
        });
    }

    function hideEditModal() {
        if(editModal) {
            editModal.classList.remove('show');
            editModal.classList.remove('d-block');
        }
        // Reset edit password input color when closing
        if (editPasswordInput) {
            editPasswordInput.style.color = '';
            editPasswordInput.type = 'password';
            const icon = document.getElementById('toggleEditPassword')?.querySelector('i');
            if (icon) { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
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
                // Make revealed edit password green
                editPasswordInput.style.color = '#28a745';
                if (icon) { icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); }
            } else {
                editPasswordInput.type = 'password';
                // Reset color when hidden
                editPasswordInput.style.color = '';
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

            const newWebsite = editWebsiteInput.value.trim(); // NEW: Get new website value
            const newUsername = editUsernameInput.value.trim();
            const newPassword = editPasswordInput.value;
            
            // Check if values were actually changed
            if (newWebsite === originalEntry.website &&
                newUsername === originalEntry.username && 
                newPassword === originalEntry.password) {
                alert("No changes were made.");
                hideEditModal();
                return;
            }
            
            // NEW: Validate website as well
            if (newWebsite && newUsername && newPassword) {
                const updatedEntry = {
                    ...originalEntry, 
                    website: newWebsite, // NEW: Include website in updated entry
                    username: newUsername,
                    password: newPassword,
                };
                updatePassword(updatedEntry);
                hideEditModal();
            } else {
                alert("Website, Username and Password cannot be empty."); // NEW: Update alert message
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
    const securedImportButton = document.getElementById('securedImportButton');
    const securedExportButton = document.getElementById('securedExportButton');

    if (securedImportButton) {
        securedImportButton.addEventListener('click', () => {
            createAndTriggerFileInput('.secured', (ev) => {
                const file = ev.target.files && ev.target.files[0];
                importPasswordsFromEvent(file, 'secured');
            });
        });
    }

    if (securedExportButton) {
        securedExportButton.addEventListener('click', exportToSecured);
    }

    // --- ENCRYPTION PASSWORD MODAL HANDLERS ---
    const encryptionModal = document.getElementById('encryptionModal');
    const encryptionPassword = document.getElementById('encryptionPassword');
    const confirmEncryptionPassword = document.getElementById('confirmEncryptionPassword');
    const toggleEncryptionPassword = document.getElementById('toggleEncryptionPassword');
    const toggleConfirmPassword = document.getElementById('toggleConfirmPassword');
    const confirmEncryptionBtn = document.getElementById('confirmEncryption');

    if (toggleEncryptionPassword) {
        toggleEncryptionPassword.addEventListener('click', function(event) {
            event.preventDefault();
            if (encryptionPassword.type === 'password') {
                encryptionPassword.type = 'text';
                this.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
            } else {
                encryptionPassword.type = 'password';
                this.innerHTML = '<i class="fa-solid fa-eye"></i>';
            }
        });
    }

    if (toggleConfirmPassword) {
        toggleConfirmPassword.addEventListener('click', function(event) {
            event.preventDefault();
            if (confirmEncryptionPassword.type === 'password') {
                confirmEncryptionPassword.type = 'text';
                this.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
            } else {
                confirmEncryptionPassword.type = 'password';
                this.innerHTML = '<i class="fa-solid fa-eye"></i>';
            }
        });
    }

    if (confirmEncryptionBtn) {
        confirmEncryptionBtn.addEventListener('click', function() {
            const pwd = encryptionPassword.value;
            const confirmPwd = confirmEncryptionPassword.value;

            // Validation
            if (!pwd || pwd.length < MIN_ENCRYPTION_PASSWORD_LENGTH) {
                createDynamicToast(`Password must be at least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters long`, 'warning');
                return;
            }

            if (pwd !== confirmPwd) {
                createDynamicToast('Passwords do not match', 'warning');
                return;
            }

            // Close modal and proceed with export
            const modal = bootstrap.Modal.getInstance(encryptionModal);
            if (modal) modal.hide();

            // Clear inputs
            encryptionPassword.value = '';
            confirmEncryptionPassword.value = '';

            // Perform export
            completeEncryptedExport(pwd);
        });
    }

    // Reset encryption modal when closed
    if (encryptionModal) {
        encryptionModal.addEventListener('hidden.bs.modal', function() {
            if (encryptionPassword) encryptionPassword.value = '';
            if (confirmEncryptionPassword) confirmEncryptionPassword.value = '';
            if (encryptionPassword) encryptionPassword.type = 'password';
            if (confirmEncryptionPassword) confirmEncryptionPassword.type = 'password';
        });
    }

    // --- DECRYPTION PASSWORD MODAL HANDLERS ---
    const decryptionModal = document.getElementById('decryptionModal');
    const decryptionPassword = document.getElementById('decryptionPassword');
    const toggleDecryptionPassword = document.getElementById('toggleDecryptionPassword');
    const confirmDecryptionBtn = document.getElementById('confirmDecryption');

    if (toggleDecryptionPassword) {
        toggleDecryptionPassword.addEventListener('click', function(event) {
            event.preventDefault();
            if (decryptionPassword.type === 'password') {
                decryptionPassword.type = 'text';
                this.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
            } else {
                decryptionPassword.type = 'password';
                this.innerHTML = '<i class="fa-solid fa-eye"></i>';
            }
        });
    }

    if (confirmDecryptionBtn) {
        confirmDecryptionBtn.addEventListener('click', function() {
            // Check rate limiting first
            const rateCheck = checkDecryptionRateLimit();
            if (!rateCheck.allowed) {
                createDynamicToast(rateCheck.message, 'danger');
                return;
            }

            const pwd = decryptionPassword.value;

            if (!pwd) {
                createDynamicToast('Please enter a password', 'warning');
                return;
            }

            if (!pendingImportFile) {
                createDynamicToast('No file to import.', 'danger');
                return;
            }

            try {
                // Perform import BEFORE closing modal to avoid clearing the file
                completeDecryptedImport(pwd);

                // Clear input and reset attempts on successful import
                decryptionPassword.value = '';
                resetDecryptionAttempts();

                // Close modal after import completes
                const modal = bootstrap.Modal.getInstance(decryptionModal);
                if (modal) modal.hide();
            } catch (error) {
                // Record failed attempt
                recordFailedDecryptionAttempt();
                updateDecryptionAttemptWarning();
                
                const remainingAttempts = MAX_DECRYPTION_ATTEMPTS - decryptionAttempts;
                let errorMsg = 'Decryption failed: ' + error.message;
                
                if (remainingAttempts > 0) {
                    errorMsg += ` (${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining)`;
                }
                
                createDynamicToast(errorMsg, 'danger');
            }
        });
    }

    // Reset decryption modal when closed
    if (decryptionModal) {
        decryptionModal.addEventListener('hidden.bs.modal', function() {
            if (decryptionPassword) decryptionPassword.value = '';
            if (decryptionPassword) decryptionPassword.type = 'password';
            // Clear pending file after modal closes (user cancelled without importing)
            pendingImportFile = null;
        });
    }

    // Install App Button
    const installAppBtn = document.getElementById('installAppBtn');
    if (installAppBtn) {
        installAppBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log(`User response to the install prompt: ${outcome}`);
                deferredPrompt = null;
                installAppBtn.style.display = 'none';
            }
        });
    }
}

// ------------------------------------------------------------------
// --- SECURITY / QR LOCK SYSTEM ---
// ------------------------------------------------------------------
const LOCK_KEY_STORAGE = 'localVault_totpSecret';

function protectLockScreenFromTampering() {
    const lockScreen = document.getElementById('lockScreen');
    if (!lockScreen) return;

    // Store the original computed style to detect changes
    let isLocked = () => !!document.getElementById('unlockCodeInput');

    // Monitor for DOM removal or attribute changes
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            // Check if lockScreen was removed from DOM
            if (mutation.type === 'childList') {
                if (!document.body.contains(lockScreen)) {
                    triggerSecurityBreach();
                    return;
                }
            }
            // Check if style or class was changed while locked
            if (mutation.type === 'attributes' && isLocked()) {
                const computed = window.getComputedStyle(lockScreen);
                if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity === '0') {
                    triggerSecurityBreach();
                    return;
                }
            }
        });
    });

    observer.observe(lockScreen, {
        attributes: true,
        attributeFilter: ['style', 'class'],
        attributeOldValue: true
    });

    observer.observe(document.body, {
        childList: true,
        subtree: false
    });

    // Also watch for direct removal attempts
    const originalRemove = Element.prototype.remove;
    Element.prototype.remove = function() {
        if (this === lockScreen) {
            triggerSecurityBreach();
            return;
        }
        originalRemove.call(this);
    };

    // Periodic check to catch any hidden attempts
    setInterval(() => {
        if (isLocked() && document.body.contains(lockScreen)) {
            const computed = window.getComputedStyle(lockScreen);
            if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity === '0') {
                triggerSecurityBreach();
            }
        }
    }, 500);

    // Monitor for className changes
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if (this === lockScreen && (name === 'style' || name === 'class') && isLocked()) {
            originalSetAttribute.call(this, name, value);
            const computed = window.getComputedStyle(lockScreen);
            if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity === '0') {
                triggerSecurityBreach();
                return;
            }
        } else {
            originalSetAttribute.call(this, name, value);
        }
    };
}

function triggerSecurityBreach() {
    // Hide entire page content
    const mainLayout = document.querySelector('.desktop-layout');
    const navbar = document.querySelector('.navbar');
    if (mainLayout) mainLayout.style.display = 'none';
    if (navbar) navbar.style.display = 'none';
    
    // Show security breach message
    const breachScreen = document.createElement('div');
    breachScreen.id = 'securityBreachScreen';
    breachScreen.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: linear-gradient(135deg, #1a1a1a, #2d2d2d);
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 99999;
        color: white;
        font-family: Arial, sans-serif;
    `;
    
    breachScreen.innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-exclamation-triangle" style="font-size: 4rem; color: #ff6b6b; margin-bottom: 20px;"></i>
            <h1 style="margin-bottom: 20px; color: #ff6b6b;">Security Breach Detected</h1>
            <p style="font-size: 1.1rem; margin-bottom: 30px; color: #ccc;">Unauthorized access attempt blocked.</p>
            <p style="color: #888;">Your vault is protected. This page is now locked.</p>
        </div>
    `;
    
    document.body.appendChild(breachScreen);
    
    // Prevent any further interaction
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
}

function initSecurity() {
    const lockScreen = document.getElementById('lockScreen');
    const lockContent = document.getElementById('lockContent');
    if (!lockScreen || !lockContent) return;

    // Enable tampering protection
    protectLockScreenFromTampering();

    // Migration: Clear old legacy key if it exists to prevent getting stuck
    if (localStorage.getItem('localVault_securityKey')) {
        localStorage.removeItem('localVault_securityKey');
    }

    const storedKey = localStorage.getItem(LOCK_KEY_STORAGE);

    // Always show lock screen initially
    lockScreen.style.display = 'flex';

    if (!storedKey) {
        renderSetupMode(lockContent);
    } else {
        renderUnlockMode(lockContent, storedKey);
    }
}

function renderSetupMode(container) {
    // Use OTPAuth to generate a secret
    const OTPAuth = window.OTPAuth;
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
        issuer: "LocalVault",
        label: "User",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: secret
    });
    
    const uri = totp.toString();

    container.innerHTML = `
        <h3 class="mb-3">Setup Mobile Security</h3>
        <p>1. Install an Authenticator app (Google Authenticator, Authy, etc.) on your phone.</p>
        <p>2. Scan this QR code with the app:</p>
        <canvas id="qrcodeCanvas" class="bg-white p-2 m-auto rounded mb-3"></canvas>
        <p class="mb-2"><strong>OR manually enter this key:</strong></p>
        <div class="input-group mb-3" style="max-width: 350px; margin: 0 auto;">
            <input type="text" id="totpSecretKeyDisplay" class="form-control text-center" readonly value="${secret.base32}">
            <button class="btn btn-outline-secondary" type="button" id="copyTotpSecretBtn" title="Copy Secret Key">
                <i class="fas fa-copy"></i>
            </button>
        </div>
        <p>3. Enter the 6-digit code from your phone to confirm:</p>
        <div class="input-group mb-3" style="max-width: 200px; margin: 0 auto;">
            <input type="text" id="setupCodeInput" class="form-control text-center" placeholder="000000" maxlength="6" autocomplete="off">
        </div>
        <button id="confirmSetupBtn" class="btn btn-success w-100">Verify & Enable</button>
    `;

    // Generate QR
    const canvas = document.getElementById('qrcodeCanvas');
    if (window.QRCode) {
        QRCode.toCanvas(canvas, uri, { width: 200, margin: 2 }, function (error) {
            if (error) console.error('QR Generation Error:', error);
        });
    }

    const setupInput = document.getElementById('setupCodeInput');
    const confirmBtn = document.getElementById('confirmSetupBtn');
    const copyTotpSecretBtn = document.getElementById('copyTotpSecretBtn'); // Get the copy button
    const totpSecretKeyDisplay = document.getElementById('totpSecretKeyDisplay'); // Get the display input

    if (copyTotpSecretBtn && totpSecretKeyDisplay) {
        copyTotpSecretBtn.addEventListener('click', function() {
            const secretText = totpSecretKeyDisplay.value;
            const btn = this;
            const originalHTML = btn.innerHTML;

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(secretText).then(() => {
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => btn.innerHTML = originalHTML, 1200);
                }).catch(err => {
                    fallbackCopyTextToClipboard(secretText, btn, originalHTML);
                });
            } else {
                fallbackCopyTextToClipboard(secretText, btn, originalHTML);
            }
        });
    }

    if (setupInput) {
        setupInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmBtn.click();
            }
        });
    }

    confirmBtn.addEventListener('click', () => {
        const token = document.getElementById('setupCodeInput').value.trim();
        const delta = totp.validate({ token: token, window: 1 });
        
        if (delta !== null) {
            localStorage.setItem(LOCK_KEY_STORAGE, secret.base32);
            location.reload();
        } else {
            alert("Invalid code. Please try again.");
        }
    });
}

function renderUnlockMode(container, secretBase32) {
    container.innerHTML = `
        <h3 class="mb-3"><i class="fas fa-lock"></i> Vault Locked</h3>
        <p>Open your Authenticator app and enter the code for <strong>LocalVault</strong>.</p>
        <div class="input-group mb-3" style="max-width: 200px; margin: 0 auto;">
            <input type="text" id="unlockCodeInput" class="form-control text-center" placeholder="000000" maxlength="6" autofocus autocomplete="off">
            <button class="btn btn-primary" id="unlockBtn"><i class="fas fa-arrow-right"></i></button>
        </div>
        <button id="resetVaultBtn" class="btn btn-outline-danger btn-sm mt-4">Reset Vault (Wipe Data)</button>
    `;

    const input = document.getElementById('unlockCodeInput');
    const btn = document.getElementById('unlockBtn');

    const attemptUnlock = () => {
        const token = input.value.trim();
        const OTPAuth = window.OTPAuth;
        
        try {
            const secret = OTPAuth.Secret.fromBase32(secretBase32);
            const totp = new OTPAuth.TOTP({
                issuer: "LocalVault",
                label: "User",
                algorithm: "SHA1",
                digits: 6,
                period: 30,
                secret: secret
            });

            const delta = totp.validate({ token: token, window: 1 });
            
            if (delta !== null) {
                document.getElementById('lockScreen').style.display = 'none';
                createDynamicToast('Identity Verified.', 'success');
            } else {
                input.classList.add('is-invalid');
                setTimeout(() => input.classList.remove('is-invalid'), 1000);
                input.value = '';
            }
        } catch (e) {
            console.error("TOTP Error", e);
            alert("Security Error. Resetting vault recommended.");
        }
    };

    btn.addEventListener('click', attemptUnlock);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') attemptUnlock();
    });

    document.getElementById('resetVaultBtn').addEventListener('click', () => {
        if(confirm("WARNING: This will delete ALL passwords and reset the app. Are you sure?")) {
             if(db) db.close();
             const req = indexedDB.deleteDatabase(DB_NAME);
             req.onsuccess = () => {
                 localStorage.removeItem(LOCK_KEY_STORAGE);
                 location.reload();
             };
             req.onerror = () => {
                 // Force reset even if DB delete errors
                 localStorage.removeItem(LOCK_KEY_STORAGE);
                 location.reload();
             };
        }
    });
}

// ------------------------------------------------------------------
// --- THEME HANDLING ---
// ------------------------------------------------------------------
function initTheme() {
    const themeBtn = document.getElementById('themeToggleBtn');
    const installBtn = document.getElementById('installAppBtn');
    const navbar = document.querySelector('.navbar');
    const body = document.body;

    const setLightMode = () => {
        body.classList.remove('dark-theme');
        body.classList.add('light-theme');
        navbar.classList.remove('navbar-dark', 'bg-dark');
        navbar.classList.add('navbar-light', 'bg-light');
        
        themeBtn.innerHTML = '<i class="fas fa-moon"></i>';
        themeBtn.title = "Switch to Dark Mode";
        themeBtn.classList.replace('btn-outline-light', 'btn-outline-dark');
        
        if (installBtn) installBtn.classList.replace('btn-outline-light', 'btn-outline-dark');
        localStorage.setItem('theme', 'light');
    };

    const setDarkMode = () => {
        body.classList.remove('light-theme');
        body.classList.add('dark-theme');
        navbar.classList.remove('navbar-light', 'bg-light');
        navbar.classList.add('navbar-dark', 'bg-dark');
        
        themeBtn.innerHTML = '<i class="fas fa-sun"></i>';
        themeBtn.title = "Switch to Light Mode";
        themeBtn.classList.replace('btn-outline-dark', 'btn-outline-light');
        
        if (installBtn) installBtn.classList.replace('btn-outline-dark', 'btn-outline-light');
        localStorage.setItem('theme', 'dark');
    };

    // Apply saved theme on load
    if (localStorage.getItem('theme') === 'light') {
        setLightMode();
    }

    themeBtn.addEventListener('click', () => {
        if (body.classList.contains('dark-theme')) {
            setLightMode();
        } else {
            setDarkMode();
        }
    });
}

// ------------------------------------------------------------------
// --- INITIALIZATION & DB OPENING ---
// ------------------------------------------------------------------

function initApp() {
    initSecurity();
    initTheme();
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

/**
 * Fallback copy implementation using an offscreen textarea and document.execCommand('copy').
 * Provides visual feedback on the button passed.
 */
function fallbackCopyTextToClipboard(text, btn, originalHTML) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        // avoid scrolling to bottom
        textarea.style.position = 'fixed';
        textarea.style.top = '-10000px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (successful) {
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => btn.innerHTML = originalHTML, 1200);
        } else {
            alert('Copy failed. Please select the password manually and copy.');
        }
    } catch (err) {
        console.error('Fallback copy failed', err);
        alert('Copy failed. Your browser may not support programmatic clipboard access.');
    }
}
