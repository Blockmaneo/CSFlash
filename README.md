# CSFlash - Real-Time Roulette Game 🎲

*Built this in a few days when I was bored and wanted to experiment with real-time gaming using Node.js. Turned out pretty decent!*

## ⚠️ Known Issues
* Some race conditions in balance updates
* Occasional socket disconnects
* Query deadlocks under heavy load 
* Steam authentication can be flaky
* Transaction rollbacks need better handling

## Key Features
* Real-time multiplayer roulette with Socket.IO
* Steam authentication
* Live chat system
* Provably fair game mechanics using SHA256
* Responsive UI with clean animations
* Transaction handling with MySQL
* Automatic game state management
* Balance tracking & betting system

## Tech Stack
* Node.js & Express
* Socket.IO
* MySQL
* Steam OAuth
* Tailwind CSS

## Installation
1. Clone repo
2. Run `npm install`
3. Set up MySQL database
4. Update Steam API key in `server.js`
5. `npm start`

## Note
*Created for educational purposes only. Use at your own risk - this is a proof of concept with known bugs. Feel free to fork and improve! 🎮*
