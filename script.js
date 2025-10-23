// --- IndexedDB Configuration ---
const DB_NAME = 'PasswordVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'passwords';

let db;

// Variables for sorting
let sortColumn = 'website';
let sortDirection = 'asc';

/**
 * 1. Opens or creates the IndexedDB database.
 * Handles the 'upgradeneeded' event to create the object store.
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.errorCode);
            alert("Error opening database. Check console for details.");
            reject(event.target.errorCode);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("Database opened successfully.");
            
            // --- FIX 1: Enable the button and update text ---
            const saveButton = document.getElementById('saveButton');
            saveButton.disabled = false;
            saveButton.textContent = 'Save Password';
            // ------------------------------------------------
            
            resolve(db);
        };

        // This runs only when the DB is created or the version number is increased.
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // Create an object store to hold password entries.
                // 'id' is the unique key path for each entry.
                const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                // Optional: Create an index for quick lookups (e.g., by website name)
                objectStore.createIndex('website', 'website', { unique: false });
                console.log("Object store created.");
            }
        };
    });
}

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
        // FIX: Update the global array before rendering
        currentPasswords = event.target.result;
        renderPasswords(currentPasswords);
    };

    request.onerror = (event) => {
        console.error("Error loading passwords:", event.target.errorCode);
    };
}

/**
 * 3. Adds a new password entry to the database (SIMPLIFIED).
 */
function addPassword(entry) {
    if (!db) return;

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.add(entry);

    request.onsuccess = (event) => {
        console.log("Password saved successfully.");
        
        // OPTIMIZATION: Manually push the entry to the array with the new ID
        entry.id = event.target.result; // IndexedDB returns the auto-incremented ID
        currentPasswords.push(entry);
        sortAndRenderPasswords(); // Re-sort and re-render to include the new entry in order
        
        // Clear inputs after successful save
        document.getElementById('website').value = '';
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
    };

    request.onerror = (event) => {
        console.error("Error saving password:", event.target.errorCode);
    };
}

/**
 * 4. Deletes a password entry by its unique ID (OPTIMIZED).
 */
function deletePassword(idToDelete) {
    if (!db) return;

    // OPTIMIZATION: Update global array and DOM immediately
    const index = currentPasswords.findIndex(p => p.id === idToDelete);
    if (index !== -1) {
        currentPasswords.splice(index, 1); // Remove from global array
        document.querySelector(`.delete-btn[data-id="${idToDelete}"]`).closest('tr').remove(); // Remove row from DOM
    }

    // Use 'readwrite' transaction for deleting data
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(idToDelete);

    request.onsuccess = () => {
        console.log(`Entry with ID ${idToDelete} deleted (Disk write confirmed).`);
        // We no longer call loadPasswords() here!
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

    // 1. Update the global array immediately (makes the UX feel faster)
    const index = currentPasswords.findIndex(p => p.id === entry.id);
    if (index !== -1) {
        currentPasswords[index] = entry;
        updateTableRow(entry); // **CRITICAL: Update the DOM immediately**
    }

    // 2. Start the asynchronous IndexedDB write
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const request = store.put(entry); 

    request.onsuccess = () => {
        // Now the disk write is complete. The UI is already updated.
        console.log(`Entry with ID ${entry.id} updated successfully (Disk write confirmed).`);
    };

    request.onerror = (event) => {
        // If the disk write failed (rare), inform the user and reload the correct data
        console.error("Error updating password:", event.target.errorCode);
        alert("Failed to save changes to disk. Reloading data.");
        loadPasswords(); 
    };
}

/**
 * 8. Prompts user for new values and calls the update function.
 */
function editEntry(idToEdit) {
    // Find the current entry using the global list
    const entry = currentPasswords.find(p => p.id === idToEdit);
    if (!entry) {
        alert("Error: Entry not found.");
        return;
    }

    // Prompt for new values
    const newUsername = prompt(`Editing ${entry.website}\n\nEnter new Username/Email:`, entry.username);
    if (newUsername === null) return; 
    
    const newPassword = prompt(`Editing ${entry.website}\n\nEnter new Password:`, entry.password);
    if (newPassword === null) return;
    
    // Check if values were actually changed
    if (newUsername.trim() === entry.username && newPassword === entry.password) {
        alert("No changes made.");
        return;
    }

    // Create the updated entry object
    const updatedEntry = {
        ...entry, // Use the spread operator to copy all original properties (like id)
        username: newUsername.trim(),
        password: newPassword,
    };

    // Send the updated entry. The updatePassword function now handles DOM and DB changes.
    updatePassword(updatedEntry);
}

/**
 * 5. Clears all entries from the object store.
 */
function clearAllPasswords() {
     if (!db) return;

    if (confirm('Are you sure you want to delete ALL saved passwords? This cannot be undone.')) {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => {
            console.log("All passwords cleared.");
            loadPasswords(); // Refresh the list (will be empty)
        };

        request.onerror = (event) => {
            console.error("Error clearing passwords:", event.target.errorCode);
        };
    }
}


// ------------------------------------------------------------------
// --- DOM and Event Handling (Same as before, but calling new DB functions) ---
// ------------------------------------------------------------------

// Function to display the list of passwords
/**
 * Function to display the list of passwords in a TABLE structure.
 */
// Global variable to hold all loaded passwords
let currentPasswords = []; // (Keep this)

/**
 * 6. Function to display the list of passwords in a TABLE structure (UPDATED for Edit button).
 */
function renderPasswords(passwords) {
    const tableBody = document.getElementById('passwordTableBody');
    tableBody.innerHTML = ''; // Clear existing rows

    if (passwords.length === 0) {
        const emptyRow = tableBody.insertRow();
        const cell = emptyRow.insertCell();
        cell.colSpan = 4;
        cell.style.textAlign = 'center';
        cell.innerHTML = 'No passwords saved yet. Start by adding one above!';
        return;
    }

    passwords.forEach((entry) => {
        const row = tableBody.insertRow();
        const maskedPassword = '*'.repeat(entry.password.length);

        // 1. Website Cell
        row.insertCell().textContent = entry.website;

        // 2. Username Cell
        row.insertCell().textContent = entry.username;

        // 3. Password Cell (Interactive)
        const passwordCell = row.insertCell();
        passwordCell.innerHTML = `<span class="password-display" data-id="${entry.id}">${maskedPassword}</span>`;
        passwordCell.style.cursor = 'pointer';

        // 4. Actions Cell (Edit and Delete Buttons)
        const actionsCell = row.insertCell();
        actionsCell.className = 'action-cell';
        actionsCell.innerHTML = `
            <button class="edit-btn" data-id="${entry.id}">Edit</button>
            <button class="delete-btn" data-id="${entry.id}">Delete</button>
        `;
    });

    // Add event listener for toggling password visibility (same as before)
    tableBody.querySelectorAll('.password-display').forEach(span => {
        span.addEventListener('click', function() {
            const id = parseInt(this.getAttribute('data-id'));
            const entry = currentPasswords.find(p => p.id === id); 
            if (entry) {
                 togglePasswordVisibility(this, entry.password);
            }
        });
    });

    // --- NEW: Add event listeners for Edit buttons ---
    tableBody.querySelectorAll('.edit-btn').forEach(button => {
        button.addEventListener('click', function() {
             const idToEdit = parseInt(this.getAttribute('data-id'));
             editEntry(idToEdit);
        });
    });

    // Add event listeners for delete buttons (same as before)
    tableBody.querySelectorAll('.delete-btn').forEach(button => {
        button.addEventListener('click', function() {
             const idToDelete = parseInt(this.getAttribute('data-id'));
             deletePassword(idToDelete);
        });
    });
}

// Function to handle saving a new password
document.getElementById('saveButton').addEventListener('click', function() {
    // Check if the database connection is ready
    if (!db) {
        alert('Database is still loading. Please wait a moment and try again.');
        // You might consider retrying openDB() here, but an alert is simpler for a local tool.
        return; 
    }
    
    const website = document.getElementById('website').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (website && username && password) {
        // Create a new password object (IndexedDB will automatically add the 'id' key)
        const newEntry = { website, username, password, createdAt: new Date() };
        
        // Call the IndexedDB function
        addPassword(newEntry);
    } else {
        alert('Please fill out all fields.');
    }
});

// Function to handle clearing all passwords
document.getElementById('clearButton').addEventListener('click', clearAllPasswords);

// Function to toggle password input type (Show/Hide button)
document.getElementById('togglePassword').addEventListener('click', function(event) {
    event.preventDefault(); // Prevent form submission
    const passwordInput = document.getElementById('password');
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        this.textContent = 'Hide';
    } else {
        passwordInput.type = 'password';
        this.textContent = 'Show';
    }
});

// Function to toggle *saved* password visibility
function togglePasswordVisibility(spanElement, realPassword) {
    if (spanElement.textContent.includes('*')) {
        // Show the real password
        spanElement.textContent = realPassword;
        spanElement.style.color = 'red';
    } else {
        // Hide the password
        spanElement.textContent = '*'.repeat(realPassword.length);
        spanElement.style.color = '#007bff';
    }
}

/**
 * Utility function to update a single row in the table (DOM).
 */
function updateTableRow(entry) {
    // 1. Find the password display span element for this entry
    // We look for any span with the matching data-id attribute
    const passwordSpan = document.querySelector(`.password-display[data-id="${entry.id}"]`);
    if (!passwordSpan) return;

    // 2. Find the entire row (<tr>) that contains this span
    const row = passwordSpan.closest('tr');
    if (!row) return;

    // 3. Update the content of the Username (second) cell
    // Cells are 0-indexed: [0: Website, 1: Username, 2: Password, 3: Actions]
    row.cells[1].textContent = entry.username;
    
    // 4. Reset the Password cell to masked
    const maskedPassword = '*'.repeat(entry.password.length);
    passwordSpan.textContent = maskedPassword;
    passwordSpan.style.color = '#007bff'; // Reset color
}

// ------------------------------------------------------------------
// --- Sorting Logic (NEW FEATURE) ---
// ------------------------------------------------------------------

document.getElementById('passwordTable').addEventListener('click', function(event) {
    const target = event.target;
    if (target.tagName === 'TH' && target.hasAttribute('data-sort')) {
        const newSortColumn = target.getAttribute('data-sort');
        
        if (newSortColumn === sortColumn) {
            // Toggle direction if clicking the same column
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            // New column clicked, set to ascending
            sortColumn = newSortColumn;
            sortDirection = 'asc';
        }
        
        sortAndRenderPasswords();
    }
});

function sortAndRenderPasswords() {
    // 1. Sort the global array (currentPasswords)
    currentPasswords.sort((a, b) => {
        const valA = a[sortColumn].toLowerCase();
        const valB = b[sortColumn].toLowerCase();

        let comparison = 0;
        if (valA > valB) {
            comparison = 1;
        } else if (valA < valB) {
            comparison = -1;
        }

        // Apply sort direction
        return sortDirection === 'desc' ? comparison * -1 : comparison;
    });

    // 2. Re-render the table with the sorted data
    renderPasswords(currentPasswords);
}

// Initial step: Open the database and then load the passwords
window.onload = () => {
    openDB()
        .then(() => {
            loadPasswords();
        })
        .catch(err => {
            console.error("Failed to initialize application:", err);
        });
};