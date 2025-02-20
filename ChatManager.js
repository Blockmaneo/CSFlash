const fs = require('fs');
const path = require('path');

const CHAT_FILE_PATH = path.join(__dirname, 'public', 'chat-messages.json');

if (!fs.existsSync(CHAT_FILE_PATH)) {
  fs.writeFileSync(CHAT_FILE_PATH, JSON.stringify([]));
}

class ChatManager {
  constructor() {
    this.messages = this.loadMessages();
  }

  loadMessages() {
    try {
      const data = fs.readFileSync(CHAT_FILE_PATH, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading chat messages:', error);
      return [];
    }
  }

  saveMessages() {
    try {
      fs.writeFileSync(CHAT_FILE_PATH, JSON.stringify(this.messages));
    } catch (error) {
      console.error('Error saving chat messages:', error);
    }
  }

  addMessage(message) {
    this.messages.push(message);
    if (this.messages.length > 15) {
      this.messages = this.messages.slice(-15);
    }
    this.saveMessages();
    return this.messages;
  }

  getMessages() {
    return this.messages;
  }
}

module.exports = ChatManager;