// Конфигурация Supabase с вашими данными
const SUPABASE_URL = 'https://yltjyxogyjcximgvjdfr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsdGp5eG9neWpjeGltZ3ZqZGZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMxNzkwMTIsImV4cCI6MjA3ODc1NTAxMn0.BHahBG8MQqQToUBnT0VyWfPqjr-k4RYwls4xoy_B_k4';

// Инициализация Supabase
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Элементы DOM
const loginScreen = document.getElementById('login-screen');
const waitingScreen = document.getElementById('waiting-screen');
const callScreen = document.getElementById('call-screen');
const roomForm = document.getElementById('room-form');
const roomNumberInput = document.getElementById('room-number');
const currentRoomSpan = document.getElementById('current-room');
const callRoomSpan = document.getElementById('call-room');
const errorMessage = document.getElementById('error-message');
const cancelWaitingBtn = document.getElementById('cancel-waiting');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const muteAudioBtn = document.getElementById('mute-audio');
const muteVideoBtn = document.getElementById('mute-video');
const endCallBtn = document.getElementById('end-call');
const switchCameraBtn = document.getElementById('switch-camera');

// Переменные состояния
let currentRoom = null;
let localStream = null;
let peerConnection = null;
let isCaller = false;
let roomTimeout = null;
let signalingChannels = [];
let activityCheckInterval = null;
let lastActivityTime = Date.now();
let userId = generateUserId();
let isUserActive = true;
let callStartTime = null;
let callTimerInterval = null;
let audioContext = null;
let volumeAnalyser = null;

// Переменные для управления камерами
let currentCamera = 'user';
let availableCameras = [];
let currentVideoTrack = null;

// Генерация уникального ID пользователя
function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

// Конфигурация STUN/TURN серверов
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ],
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM загружен, инициализируем приложение...');
    initializeApp();
});

function initializeApp() {
    console.log('Инициализация приложения...');
    
    // Проверка подключения к Supabase
    supabase.from('rooms').select('count', { count: 'exact', head: true })
        .then(() => console.log('Подключение к Supabase: OK'))
        .catch(error => console.error('Подключение к Supabase: ERROR', error));

    roomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('Форма отправлена');
        
        const roomNumber = roomNumberInput.value.trim();
        console.log('Номер комнаты:', roomNumber);
        
        if (!roomNumber || !/^\d{1,14}$/.test(roomNumber)) {
            showError('Пожалуйста, введите корректный номер (1-14 цифр)');
            return;
        }
        
        await joinRoom(roomNumber);
    });

    cancelWaitingBtn.addEventListener('click', () => {
        console.log('Отмена ожидания');
        leaveRoom();
        showScreen(loginScreen);
    });

    muteAudioBtn.addEventListener('click', toggleAudio);
    muteVideoBtn.addEventListener('click', toggleVideo);
    endCallBtn.addEventListener('click', endCall);
    
    if (switchCameraBtn) {
        switchCameraBtn.addEventListener('click', switchCamera);
    }

    roomNumberInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 14);
    });

    setupActivityTracking();
    startRoomCleanupInterval();
    
    console.log('Приложение инициализировано');
}

// Настройка отслеживания активности
function setupActivityTracking() {
    const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    activityEvents.forEach(event => {
        document.addEventListener(event, updateActivity, true);
    });

    activityCheckInterval = setInterval(checkActivity, 30000);
}

// Обновление времени активности
function updateActivity() {
    lastActivityTime = Date.now();
    isUserActive = true;
    
    if (currentRoom) {
        updateUserActivity();
    }
}

// Проверка активности
function checkActivity() {
    const inactiveTime = Date.now() - lastActivityTime;
    const inactiveThreshold = 5 * 60 * 1000;
    
    if (inactiveTime > inactiveThreshold && isUserActive) {
        isUserActive = false;
        console.log('Пользователь неактивен более 5 минут');
        
        if (currentRoom) {
            showError('Вы были неактивны более 5 минут. Комната будет удалена.');
            endCall();
        }
    }
}

// Запуск периодической очистки комнат
function startRoomCleanupInterval() {
    setInterval(async () => {
        await cleanupInactiveRooms();
    }, 2 * 60 * 1000);
}

// Функция получения списка доступных камер
async function getAvailableCameras() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        
        console.log('Доступные камеры:', videoDevices);
        return videoDevices;
    } catch (error) {
        console.error('Ошибка получения списка камер:', error);
        return [];
    }
}

// Функция переключения камеры
async function switchCamera() {
    if (!localStream) return;
    
    try {
        console.log('Переключаем камеру...');
        
        const currentVideoTracks = localStream.getVideoTracks();
        if (currentVideoTracks.length === 0) {
            console.log('Нет активного видео трека');
            return;
        }
        
        currentVideoTracks.forEach(track => {
            track.stop();
            localStream.removeTrack(track);
        });
        
        let nextCamera = currentCamera === 'user' ? 'environment' : 'user';
        
        const cameras = await getAvailableCameras();
        if (cameras.length < 2) {
            console.log('Доступна только одна камера');
            showNotification('Доступна только одна камера', 'info');
            return;
        }
        
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: nextCamera,
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: false
        });
        
        const newVideoTrack = newStream.getVideoTracks()[0];
        localStream.addTrack(newVideoTrack);
        currentVideoTrack = newVideoTrack;
        currentCamera = nextCamera;
        
        localVideo.srcObject = localStream;
        
        if (peerConnection) {
            const senders = peerConnection.getSenders();
            const videoSender = senders.find(sender => 
                sender.track && sender.track.kind === 'video'
            );
            
            if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
                console.log('Видео трек заменен в PeerConnection');
            }
        }
        
        updateSwitchCameraButton();
        
        console.log('Камера переключена на:', currentCamera);
        showNotification(`Камера переключена на ${currentCamera === 'user' ? 'фронтальную' : 'заднюю'}`, 'info');
        
    } catch (error) {
        console.error('Ошибка переключения камеры:', error);
        showError('Не удалось переключить камеру: ' + error.message);
        await switchCameraAlternative();
    }
}

// Альтернативный метод переключения камеры
async function switchCameraAlternative() {
    try {
        const cameras = await getAvailableCameras();
        if (cameras.length < 2) {
            showNotification('Доступна только одна камера', 'info');
            return;
        }
        
        const currentDeviceId = currentVideoTrack?.getSettings().deviceId;
        const currentIndex = cameras.findIndex(cam => cam.deviceId === currentDeviceId);
        const nextIndex = (currentIndex + 1) % cameras.length;
        const nextCamera = cameras[nextIndex];
        
        const currentVideoTracks = localStream.getVideoTracks();
        currentVideoTracks.forEach(track => {
            track.stop();
            localStream.removeTrack(track);
        });
        
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                deviceId: { exact: nextCamera.deviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: false
        });
        
        const newVideoTrack = newStream.getVideoTracks()[0];
        localStream.addTrack(newVideoTrack);
        currentVideoTrack = newVideoTrack;
        
        localVideo.srcObject = localStream;
        
        if (peerConnection) {
            const senders = peerConnection.getSenders();
            const videoSender = senders.find(sender => 
                sender.track && sender.track.kind === 'video'
            );
            
            if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
            }
        }
        
        const cameraLabel = nextCamera.label.toLowerCase();
        if (cameraLabel.includes('back') || cameraLabel.includes('rear') || cameraLabel.includes('environment')) {
            currentCamera = 'environment';
        } else {
            currentCamera = 'user';
        }
        
        updateSwitchCameraButton();
        
        console.log('Камера переключена альтернативным методом');
        showNotification(`Камера переключена на ${currentCamera === 'user' ? 'фронтальную' : 'заднюю'}`, 'info');
        
    } catch (error) {
        console.error('Ошибка альтернативного переключения камеры:', error);
        showError('Не удалось переключить камеру');
    }
}

// Обновление иконки кнопки переключения камеры
function updateSwitchCameraButton() {
    if (!switchCameraBtn) return;
    
    const icon = switchCameraBtn.querySelector('svg');
    if (icon) {
        icon.innerHTML = '';
        
        if (currentCamera === 'user') {
            icon.innerHTML = `
                <path d="M12 12c1.65 0 3-1.35 3-3s-1.35-3-3-3-3 1.35-3 3 1.35 3 3 3zm0-4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm6 8.58c0-2.5-3.97-3.58-6-3.58s-6 1.08-6 3.58V18h12v-1.42zM8.48 16c.74-.51 2.23-1 3.52-1s2.78.49 3.52 1H8.48z"/>
            `;
        } else {
            icon.innerHTML = `
                <path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.42 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
            `;
        }
    }
}

// Функция присоединения к комнате - ПЕРЕПИСАННАЯ
async function joinRoom(roomNumber) {
    try {
        console.log('=== НАЧАЛО ПРИСОЕДИНЕНИЯ К КОМНАТЕ ===');
        console.log('Номер комнаты:', roomNumber);
        
        currentRoom = roomNumber;
        currentRoomSpan.textContent = roomNumber;

        // 1. Сразу показываем экран ожидания
        console.log('Показываем экран ожидания...');
        showScreen(waitingScreen);

        // 2. Настраиваем медиаустройства
        console.log('Настраиваем медиаустройства...');
        await setupMedia();
        console.log('Медиаустройства настроены');

        // 3. Проверяем существование комнаты
        console.log('Проверяем существование комнаты в БД...');
        const { data: existingRoom, error } = await supabase
            .from('rooms')
            .select('*')
            .eq('room_number', roomNumber)
            .single();

        console.log('Результат запроса комнаты:', { existingRoom, error });

        if (error) {
            if (error.code === 'PGRST116') {
                // Комната не существует - создаем новую
                console.log('Комната не существует, создаем новую...');
                isCaller = true;
                await createNewRoom();
                console.log('Новая комната создана, ждем второго участника...');
            } else {
                throw error;
            }
        } else {
            // Комната существует
            console.log('Комната существует:', existingRoom);
            
            if (existingRoom.participants >= 2) {
                showError('Комната уже заполнена. Максимум 2 участника.');
                showScreen(loginScreen);
                return;
            }

            if (isRoomExpired(existingRoom)) {
                console.log('Комната устарела, удаляем и создаем новую...');
                await supabase.from('rooms').delete().eq('room_number', roomNumber);
                await supabase.from('signaling').delete().eq('room_number', roomNumber);
                
                isCaller = true;
                await createNewRoom();
            } else {
                // Присоединяемся к существующей комнате
                console.log('Присоединяемся к существующей комнате...');
                isCaller = false;
                await joinExistingRoom(existingRoom);
            }
        }

        // 4. Сбрасываем таймаут комнаты
        resetRoomTimeout();
        console.log('=== ПРИСОЕДИНЕНИЕ УСПЕШНО ЗАВЕРШЕНО ===');

    } catch (error) {
        console.error('!!! ОШИБКА ПРИ ПРИСОЕДИНЕНИИ К КОМНАТЕ !!!', error);
        showError('Не удалось присоединиться к комнате: ' + error.message);
        showScreen(loginScreen);
        cleanup();
    }
}

// Функция создания новой комнаты - УПРОЩЕННАЯ
async function createNewRoom() {
    console.log('Создаем новую комнату в БД...');
    const { data, error } = await supabase
        .from('rooms')
        .insert([
            { 
                room_number: currentRoom,
                created_at: new Date().toISOString(),
                participants: 1,
                last_activity: new Date().toISOString(),
                user_ids: [userId]
            }
        ])
        .select()
        .single();

    if (error) {
        console.error('Ошибка создания комнаты:', error);
        throw error;
    }

    console.log('Комната создана:', data);
    
    // Подписываемся на изменения комнаты
    subscribeToRoomChanges();
    console.log('Подписка на изменения комнаты установлена');
}

// Функция присоединения к существующей комнате - УПРОЩЕННАЯ
async function joinExistingRoom(room) {
    console.log('Обновляем комнату для присоединения второго участника...');
    
    const updatedUserIds = [...(room.user_ids || []), userId];
    
    const { error } = await supabase
        .from('rooms')
        .update({ 
            participants: 2,
            last_activity: new Date().toISOString(),
            user_ids: updatedUserIds
        })
        .eq('room_number', currentRoom);

    if (error) {
        console.error('Ошибка обновления комнаты:', error);
        throw error;
    }

    console.log('Комната обновлена, участников: 2');
    
    // Подписываемся на изменения комнаты
    subscribeToRoomChanges();
    
    // НЕМЕДЛЕННО начинаем звонок, так как мы второй участник
    console.log('Немедленно начинаем звонок как второй участник...');
    await startCall();
}

// Функция настройки медиа - УПРОЩЕННАЯ
async function setupMedia() {
    try {
        console.log('Запрашиваем доступ к камере и микрофону...');
        
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 }
            }
        });

        console.log('Медиаустройства получены успешно');
        
        // Настраиваем локальное видео
        localVideo.srcObject = localStream;
        localVideo.muted = true;
        
        console.log('Локальное видео настроено');

    } catch (error) {
        console.error('Ошибка доступа к медиаустройствам:', error);
        
        // Пробуем получить только аудио
        try {
            console.log('Пробуем получить только аудио...');
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false
            });
            
            localVideo.srcObject = localStream;
            localVideo.muted = true;
            
            console.log('Только аудио получено успешно');
            showNotification('Видео недоступно, но аудио работает', 'warning');
            
        } catch (audioError) {
            console.error('Не удалось получить доступ к микрофону:', audioError);
            throw new Error('Не удалось получить доступ к камере и микрофону');
        }
    }
}

// Функция подписки на изменения комнаты - УПРОЩЕННАЯ
function subscribeToRoomChanges() {
    console.log('Настраиваем подписку на изменения комнаты...');
    
    const roomChannel = supabase
        .channel(`room-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'rooms',
                filter: `room_number=eq.${currentRoom}`
            },
            async (payload) => {
                console.log('Получено изменение комнаты:', payload);
                
                if (payload.eventType === 'UPDATE') {
                    console.log('Комната обновлена:', payload.new);
                    
                    // Если мы создатель комнаты и появился второй участник
                    if (payload.new.participants === 2 && isCaller) {
                        console.log('Второй участник присоединился! Начинаем звонок...');
                        await startCall();
                    }
                }
            }
        )
        .subscribe((status) => {
            console.log('Статус подписки на комнату:', status);
        });
    
    signalingChannels.push(roomChannel);
}

// Функция начала звонка - УПРОЩЕННАЯ
async function startCall() {
    console.log('=== НАЧАЛО ЗВОНКА ===');
    
    // 1. Показываем экран звонка
    showScreen(callScreen);
    callRoomSpan.textContent = currentRoom;
    console.log('Экран звонка показан');

    // 2. Запускаем таймер
    startCallTimer();
    console.log('Таймер звонка запущен');

    try {
        // 3. Создаем PeerConnection
        peerConnection = new RTCPeerConnection(configuration);
        console.log('PeerConnection создан');

        // 4. Добавляем локальные треки
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
            console.log('Добавлен трек:', track.kind);
        });

        // 5. Обработчик удаленного потока
        peerConnection.ontrack = (event) => {
            console.log('Получен удаленный поток');
            if (event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                remoteVideo.play().catch(console.error);
                console.log('Удаленное видео настроено');
            }
        };

        // 6. Обработчик ICE кандидатов
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                saveIceCandidate(event.candidate);
            }
        };

        if (isCaller) {
            // Создаем предложение
            console.log('Создаем offer как создатель комнаты...');
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            await saveOffer(offer);
            listenForAnswer();
            console.log('Offer создан и сохранен');
        } else {
            // Слушаем предложение
            console.log('Слушаем offer как второй участник...');
            listenForOffer();
        }
        
        listenForIceCandidates();
        console.log('=== ЗВОНОК УСПЕШНО НАЧАТ ===');

    } catch (error) {
        console.error('!!! ОШИБКА НАЧАЛА ЗВОНКА !!!', error);
        showError('Ошибка при установке соединения');
        endCall();
    }
}

// Проверка устаревания комнаты
function isRoomExpired(room) {
    const lastActivity = new Date(room.last_activity);
    const now = new Date();
    const diffMinutes = (now - lastActivity) / (1000 * 60);
    return diffMinutes > 10;
}

// Очистка неактивных комнат
async function cleanupInactiveRooms() {
    try {
        const { data: allRooms, error } = await supabase
            .from('rooms')
            .select('*');
        
        if (error) throw error;
        
        const now = new Date();
        const cleanupPromises = allRooms.map(async (room) => {
            const lastActivity = new Date(room.last_activity);
            const diffMinutes = (now - lastActivity) / (1000 * 60);
            
            if (diffMinutes > 10 || room.participants === 0) {
                console.log('Удаляем неактивную комнату:', room.room_number);
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', room.room_number);
                
                await supabase
                    .from('signaling')
                    .delete()
                    .eq('room_number', room.room_number);
            }
        });
        
        await Promise.all(cleanupPromises);
    } catch (error) {
        console.error('Ошибка при очистке комнат:', error);
    }
}

// Мониторинг активности комнаты
function startRoomActivityMonitoring() {
    const activityInterval = setInterval(async () => {
        if (currentRoom && isUserActive) {
            await updateUserActivity();
        } else {
            clearInterval(activityInterval);
        }
    }, 60000);
}

// Обновление активности пользователя
async function updateUserActivity() {
    if (!currentRoom) return;
    
    try {
        const { error } = await supabase
            .from('rooms')
            .update({ 
                last_activity: new Date().toISOString()
            })
            .eq('room_number', currentRoom);
        
        if (error) console.error('Ошибка обновления активности:', error);
    } catch (error) {
        console.error('Ошибка обновления активности:', error);
    }
}

// Запуск таймера звонка
function startCallTimer() {
    callStartTime = Date.now();
    updateCallTimer();
    
    callTimerInterval = setInterval(updateCallTimer, 1000);
}

// Обновление таймера звонка
function updateCallTimer() {
    if (!callStartTime) return;
    
    const elapsed = Date.now() - callStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    
    const timerElement = document.getElementById('call-timer') || createCallTimerElement();
    timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Создание элемента таймера
function createCallTimerElement() {
    const timerElement = document.createElement('div');
    timerElement.id = 'call-timer';
    timerElement.className = 'call-timer';
    timerElement.textContent = '00:00';
    
    const callContainer = document.querySelector('.call-container');
    const roomInfo = callContainer.querySelector('p');
    roomInfo.appendChild(timerElement);
    
    return timerElement;
}

// Функция сохранения предложения в Supabase
async function saveOffer(offer) {
    const { error } = await supabase
        .from('signaling')
        .insert([
            {
                room_number: currentRoom,
                type: 'offer',
                sdp: offer.sdp
            }
        ]);
    
    if (error) throw error;
}

// Функция сохранения ICE кандидата в Supabase
async function saveIceCandidate(candidate) {
    const { error } = await supabase
        .from('signaling')
        .insert([
            {
                room_number: currentRoom,
                type: 'ice-candidate',
                candidate: JSON.stringify(candidate)
            }
        ]);
    
    if (error) console.error('Ошибка сохранения ICE кандидата:', error);
}

// Функция прослушивания предложения
function listenForOffer() {
    const offerChannel = supabase
        .channel(`offer-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'signaling',
                filter: `room_number=eq.${currentRoom} AND type=eq.offer`
            },
            async (payload) => {
                console.log('Получено предложение');
                await handleOffer(payload.new);
            }
        )
        .subscribe((status) => {
            console.log('Статус подписки на предложения:', status);
        });
    
    signalingChannels.push(offerChannel);
}

// Функция обработки предложения
async function handleOffer(offerData) {
    if (!isCaller && peerConnection) {
        try {
            console.log('Обрабатываем полученное предложение');
            
            await peerConnection.setRemoteDescription({
                type: 'offer',
                sdp: offerData.sdp
            });
            
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            const { error } = await supabase
                .from('signaling')
                .insert([
                    {
                        room_number: currentRoom,
                        type: 'answer',
                        sdp: answer.sdp
                    }
                ]);
            
            if (error) throw error;
            
            console.log('Ответ отправлен');
            
        } catch (error) {
            console.error('Ошибка обработки предложения:', error);
            showError('Ошибка при соединении: ' + error.message);
        }
    }
}

// Функция прослушивания ответа
function listenForAnswer() {
    const answerChannel = supabase
        .channel(`answer-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'signaling',
                filter: `room_number=eq.${currentRoom} AND type=eq.answer`
            },
            async (payload) => {
                console.log('Получен ответ');
                if (peerConnection) {
                    try {
                        await peerConnection.setRemoteDescription({
                            type: 'answer',
                            sdp: payload.new.sdp
                        });
                        console.log('Удаленное описание установлено');
                    } catch (error) {
                        console.error('Ошибка установки remote description:', error);
                    }
                }
            }
        )
        .subscribe((status) => {
            console.log('Статус подписки на ответы:', status);
        });
    
    signalingChannels.push(answerChannel);
}

// Функция прослушивания ICE кандидатов
function listenForIceCandidates() {
    const iceChannel = supabase
        .channel(`ice-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'signaling',
                filter: `room_number=eq.${currentRoom} AND type=eq.ice-candidate`
            },
            async (payload) => {
                console.log('Получен ICE кандидат');
                if (peerConnection && peerConnection.remoteDescription) {
                    try {
                        const candidate = JSON.parse(payload.new.candidate);
                        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (error) {
                        console.error('Ошибка добавления ICE кандидата:', error);
                    }
                }
            }
        )
        .subscribe((status) => {
            console.log('Статус подписки на ICE кандидаты:', status);
        });
    
    signalingChannels.push(iceChannel);
}

// Функция переключения аудио
function toggleAudio() {
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            const audioTrack = audioTracks[0];
            audioTrack.enabled = !audioTrack.enabled;
            muteAudioBtn.classList.toggle('muted', !audioTrack.enabled);
            
            const videoWrapper = localVideo.closest('.video-wrapper');
            if (videoWrapper) {
                videoWrapper.classList.toggle('audio-muted', !audioTrack.enabled);
            }
            
            console.log('Аудио ' + (audioTrack.enabled ? 'включено' : 'выключено'));
            showNotification(`Микрофон ${audioTrack.enabled ? 'включен' : 'выключен'}`, 'info');
        } else {
            console.log('Аудио треки не найдены');
        }
    }
}

// Функция переключения видео
function toggleVideo() {
    if (localStream) {
        const videoTracks = localStream.getVideoTracks();
        if (videoTracks.length > 0) {
            const videoTrack = videoTracks[0];
            videoTrack.enabled = !videoTrack.enabled;
            muteVideoBtn.classList.toggle('muted', !videoTrack.enabled);
            
            console.log('Видео ' + (videoTrack.enabled ? 'включено' : 'выключено'));
            showNotification(`Камера ${videoTrack.enabled ? 'включена' : 'выключена'}`, 'info');
        }
    }
}

// Функция завершения звонка
async function endCall() {
    console.log('Завершение звонка');
    
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    callStartTime = null;
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log('Остановлен трек:', track.kind);
        });
        localStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    await leaveRoom();
    showScreen(loginScreen);
}

// Функция выхода из комнаты
async function leaveRoom() {
    if (currentRoom) {
        try {
            const { data: room, error: fetchError } = await supabase
                .from('rooms')
                .select('*')
                .eq('room_number', currentRoom)
                .single();
            
            if (!fetchError && room) {
                const updatedUserIds = (room.user_ids || []).filter(id => id !== userId);
                const updatedParticipants = Math.max(0, room.participants - 1);
                
                if (updatedParticipants === 0) {
                    await supabase
                        .from('rooms')
                        .delete()
                        .eq('room_number', currentRoom);
                } else {
                    await supabase
                        .from('rooms')
                        .update({ 
                            participants: updatedParticipants,
                            user_ids: updatedUserIds,
                            last_activity: new Date().toISOString()
                        })
                        .eq('room_number', currentRoom);
                }
            }
            
            await supabase
                .from('signaling')
                .delete()
                .eq('room_number', currentRoom);
                
        } catch (error) {
            console.error('Ошибка при выходе из комнаты:', error);
        }
        
        cleanupSignalingChannels();
        currentRoom = null;
    }
    
    if (roomTimeout) {
        clearTimeout(roomTimeout);
        roomTimeout = null;
    }
}

// Функция очистки signaling каналов
function cleanupSignalingChannels() {
    signalingChannels.forEach(channel => {
        supabase.removeChannel(channel);
    });
    signalingChannels = [];
}

// Функция сброса таймаута комнаты
function resetRoomTimeout() {
    if (roomTimeout) {
        clearTimeout(roomTimeout);
    }
    
    roomTimeout = setTimeout(async () => {
        if (currentRoom && !callScreen.classList.contains('active')) {
            try {
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', currentRoom);
                
                await supabase
                    .from('signaling')
                    .delete()
                    .eq('room_number', currentRoom);
                
                showScreen(loginScreen);
                showError('Время ожидания истекло. Комната удалена.');
            } catch (error) {
                console.error('Ошибка удаления комнаты по таймауту:', error);
            }
        }
    }, 10 * 60 * 1000);
}

// Функция показа экрана
function showScreen(screen) {
    console.log('Переключаем экран на:', screen.id);
    
    loginScreen.classList.remove('active');
    waitingScreen.classList.remove('active');
    callScreen.classList.remove('active');
    
    screen.classList.add('active');
}

// Функция показа ошибки
function showError(message) {
    console.error('Показываем ошибку:', message);
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
    
    setTimeout(() => {
        errorMessage.classList.add('hidden');
    }, 5000);
}

// Функция показа уведомления
function showNotification(message, type = 'info') {
    console.log('Показываем уведомление:', message);
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 100);
    
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Функция очистки
function cleanup() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    cleanupSignalingChannels();
    
    if (roomTimeout) {
        clearTimeout(roomTimeout);
        roomTimeout = null;
    }
    
    if (activityCheckInterval) {
        clearInterval(activityCheckInterval);
        activityCheckInterval = null;
    }
    
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    callStartTime = null;
    currentRoom = null;
}

// Обработчики для отслеживания закрытия вкладки
window.addEventListener('beforeunload', async (e) => {
    if (currentRoom) {
        e.preventDefault();
        e.returnValue = '';
        
        const data = new Blob([JSON.stringify({
            room_number: currentRoom,
            user_id: userId,
            action: 'leave'
        })], { type: 'application/json' });
        
        navigator.sendBeacon('/api/leave-room', data);
        await leaveRoom();
    }
});

window.addEventListener('pagehide', async () => {
    if (currentRoom) {
        await leaveRoom();
    }
});

// Обработчик видимости страницы
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        updateActivity();
    }
});

console.log('Online Call App инициализирован');
