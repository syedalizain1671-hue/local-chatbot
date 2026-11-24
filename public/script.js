// Har browser ki apni pehchan (refresh par bhi wahi rehti hai)
function getSessionId() {
    let id = localStorage.getItem('chatSessionId');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('chatSessionId', id);
    }
    return id;
}
const sessionId = getSessionId();

// Live Server (port 5500) par localhost:3000, deploy par same domain
const API_URL = location.port === '5500' ? 'http://localhost:3000' : '';

// 1. HTML Elements ko select karna
const chatMessages = document.querySelector('.chat-messages');
const messagesContainer = document.querySelector('.messages-container');
const inputForm = document.querySelector('.input-form');
const welcomeTitle = document.querySelector('.title');
const userInput = document.querySelector('.input-form input');
const sendButton = document.getElementById('button');

// 2. Current Time nikalne ka helper function (e.g., "11:25 PM")
function getCurrentTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// 3. Screen par naya message bubble add karne ka function
function addMessage(text, sender) {
    const messageDiv = document.createElement('div');

    // Agar user hai toh 'user-message' class, agar bot hai toh 'bot-message' class
    messageDiv.classList.add('message', sender === 'user' ? 'user-message' : 'bot-message');

    // Message text aur timestamp ko HTML structure ke mutabiq set karna
    const textSpan = document.createElement('span');
    textSpan.classList.add('message-text');
    textSpan.innerText = text;

    const timeSpan = document.createElement('span');
    timeSpan.classList.add('timestamp');
    timeSpan.innerText = getCurrentTime();

    messageDiv.appendChild(textSpan);
    messageDiv.appendChild(timeSpan);
    messagesContainer.appendChild(messageDiv);

    // Chat screen ko automatic neeche scroll karna
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return textSpan; // Taake baad mein "Typing..." ko asli jawab se badal sakein
}

// 4. Form submit hone par (Send button click ya Enter dabane par)
inputForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // Page reload hone se rokna

    const message = userInput.value.trim();
    if (!message) return;

    // User ka message screen par show karein aur input box khaali karein
    addMessage(message, 'user');
    userInput.value = '';

    if (welcomeTitle) {
        welcomeTitle.style.display = 'none';
    }

    // Button ko thodi der ke liye disable karein taake double-click na ho
    sendButton.disabled = true;

    // Loading ("Typing...") bubble show karein
    // const botTextSpan = addMessage('Typing...', 'bot');
    // Loading (3 bouncing dots) bubble show karein
    const botTextSpan = addMessage('', 'bot');
    botTextSpan.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';

    try {
        // Apne Express backend ko request bhejein
        const response = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: message, sessionId: sessionId }),
        });

        const data = await response.json();

        // "Typing..." ki jagah AI ka asli jawab dikhayein
        if (data.reply) {
            const formattedText = data.reply
                .replace(/### (.*)/g, '<h4>$1</h4>')        // ### Heading ko bold heading banayega
                .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')    // **bold** ko asli bold banayega
                .replace(/\n/g, '<br>');                   // New lines ko sahi space dega

            botTextSpan.innerHTML = formattedText;
        } else {
            botTextSpan.innerText = data.error || 'Sorry...! No reply receive from Server.';
        }
    } catch (error) {
        console.error('Fetch Error:', error);
        botTextSpan.innerText = 'Error: Backend server is not working';
    } finally {
        // Button wapas enable karein aur neeche scroll karein
        sendButton.disabled = false;
        userInput.focus();
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
});
