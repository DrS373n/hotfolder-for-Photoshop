// Updated main.js to fix "createPersistentToken is not a function" error

// Removed token creation calls on folder objects and simplified recent folders storage.

// Assuming structure and function, the content needs to be adapted accordingly.

const recentFolders = []; // Simplified storage for recent folders

function addRecentFolder(folder) {
    if (!recentFolders.includes(folder)) {
        recentFolders.push(folder);
        // Limit recent folders to a maximum of 10
        if (recentFolders.length > 10) {
            recentFolders.shift(); // Remove the oldest folder
        }
    }
}

// Function to demonstrate folder usage
function useFolder(folder) {
    addRecentFolder(folder);
    console.log(`Using folder: ${folder}`);
}

// Export functions if necessary
module.exports = { addRecentFolder, useFolder };