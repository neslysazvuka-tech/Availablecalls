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
        { urls: 'stun:stun2.l.google.com:19302' },
        { 
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        { 
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
            username: 'webrtc',
            credential: 'webrtc'
        }
    ],
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    roomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const roomNumber = roomNumberInput.value.trim();
        
        if (!roomNumber || !/^\d{1,14}$/.test(roomNumber)) {
            showError('Пожалуйста, введите корректный номер (1-14 цифр)');
            return;
        }
        
        await joinRoom(roomNumber);
    });

    cancelWaitingBtn.addEventListener('click', () => {
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

// Функция присоединения к комнате
async function joinRoom(roomNumber) {
    try {
        currentRoom = roomNumber;
        currentRoomSpan.textContent = roomNumber;
        
        await cleanupInactiveRooms();
        
        const { data: existingRoom, error } = await supabase
            .from('rooms')
            .select('*')
            .eq('room_number', roomNumber)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        
        if (existingRoom) {
            if (isRoomExpired(existingRoom)) {
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', roomNumber);
                
                await supabase
                    .from('signaling')
                    .delete()
                    .eq('room_number', roomNumber);
                
                isCaller = true;
                await setupMedia();
                await createNewRoom();
            } else {
                if (existingRoom.participants >= 2) {
                    showError('Комната уже заполнена. Максимум 2 участника.');
                    return;
                }
                isCaller = false;
                await setupMedia();
                await joinExistingRoom(existingRoom);
            }
        } else {
            isCaller = true;
            await setupMedia();
            await createNewRoom();
        }
        
        showScreen(waitingScreen);
        resetRoomTimeout();
        
    } catch (error) {
        console.error('Ошибка при присоединении к комнате:', error);
        showError('Не удалось присоединиться к комнате: ' + error.message);
        cleanup();
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

// Функция создания новой комнаты
async function createNewRoom() {
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
    
    if (error) throw error;
    
    subscribeToRoomChanges();
    startRoomActivityMonitoring();
}

// Функция присоединения к существующей комнате
async function joinExistingRoom(room) {
    const updatedUserIds = [...(room.user_ids || []), userId];
    
    const { error } = await supabase
        .from('rooms')
        .update({ 
            participants: 2,
            last_activity: new Date().toISOString(),
            user_ids: updatedUserIds
        })
        .eq('room_number', currentRoom);
    
    if (error) throw error;
    
    subscribeToRoomChanges();
    startRoomActivityMonitoring();
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

// Функция подписки на изменения комнаты
function subscribeToRoomChanges() {
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
                console.log('Room update:', payload);
                
                if (payload.eventType === 'UPDATE') {
                    if (payload.new.participants === 2 && isCaller) {
                        await startCall();
                    }
                    
                    if (payload.new.participants === 0) {
                        showError('Комната была автоматически удалена из-за неактивности');
                        endCall();
                    }
                } else if (payload.eventType === 'DELETE') {
                    if (callScreen.classList.contains('active')) {
                        showError('Комната была удалена');
                        endCall();
                    } else {
                        showError('Комната была удалена');
                        showScreen(loginScreen);
                    }
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to room changes');
            }
        });
    
    signalingChannels.push(roomChannel);
}

// Функция настройки медиа
async function setupMedia() {
    try {
        console.log('Запрашиваем доступ к микрофону и камере...');
        
        availableCameras = await getAvailableCameras();
        console.log('Доступные камеры:', availableCameras.length);
        
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                googEchoCancellation: true,
                googAutoGainControl: true,
                googNoiseSuppression: true,
                googHighpassFilter: true,
                channelCount: 1,
                sampleRate: 48000,
                sampleSize: 16,
                latency: 0.01
            },
            video: {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            }
        });

        currentVideoTrack = localStream.getVideoTracks()[0];
        currentCamera = 'user';
        
        console.log('Медиаустройства получены успешно');

        localVideo.srcObject = localStream;
        localVideo.muted = true;
        localVideo.volume = 0;
        
        updateSwitchCameraButton();
        
        if (availableCameras.length > 1 && switchCameraBtn) {
            switchCameraBtn.style.display = 'flex';
        } else if (switchCameraBtn) {
            switchCameraBtn.style.display = 'none';
        }
        
        setupVolumeMeter();
        await testAudioOutput();
        
    } catch (error) {
        console.error('Ошибка доступа к медиаустройствам:', error);
        
        try {
            console.log('Пробуем получить только аудио...');
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            
            localVideo.srcObject = localStream;
            localVideo.muted = true;
            localVideo.volume = 0;
            
            if (switchCameraBtn) {
                switchCameraBtn.style.display = 'none';
            }
            
            setupVolumeMeter();
            await testAudioOutput();
            
            showError('Видео недоступно, но аудио работает');
        } catch (audioError) {
            console.error('Не удалось получить доступ к микрофону:', audioError);
            showError('Не удалось получить доступ к камере и микрофону. Пожалуйста, разрешите доступ и обновите страницу.');
            throw error;
        }
    }
}

// Настройка визуализатора громкости
function setupVolumeMeter() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(localStream);
        volumeAnalyser = audioContext.createAnalyser();
        volumeAnalyser.fftSize = 256;
        source.connect(volumeAnalyser);
        
        updateVolumeMeter();
    } catch (error) {
        console.warn('Не удалось настроить визуализатор громкости:', error);
    }
}

// Обновление индикатора громкости
function updateVolumeMeter() {
    if (!volumeAnalyser) return;
    
    const dataArray = new Uint8Array(volumeAnalyser.frequencyBinCount);
    volumeAnalyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    const average = sum / dataArray.length;
    
    const volumeLevel = document.querySelector('.volume-level');
    if (volumeLevel) {
        const height = Math.min(100, (average / 128) * 100);
        volumeLevel.style.height = height + '%';
        volumeLevel.style.background = height > 50 ? '#4ade80' : height > 20 ? '#f59e0b' : '#ef4444';
    }
    
    requestAnimationFrame(updateVolumeMeter);
}

// Тестирование аудио вывода
async function testAudioOutput() {
    try {
        const testAudio = new Audio();
        testAudio.volume = 0.1;
        
        await testAudio.play().then(() => {
            testAudio.pause();
            console.log('Аудио вывод работает нормально');
        }).catch(error => {
            console.warn('Автовоспроизведение аудио заблокировано:', error);
        });
    } catch (error) {
        console.warn('Тест аудио вывода не удался:', error);
    }
}

// Функция начала звонка
async function startCall() {
    console.log('Начинаем звонок...');
    showScreen(callScreen);
    callRoomSpan.textContent = currentRoom;
    
    startCallTimer();
    
    try {
        peerConnection = new RTCPeerConnection(configuration);
        
        peerConnection.onnegotiationneeded = async () => {
            console.log('Требуется переnegotiation');
        };

        localStream.getTracks().forEach(track => {
            console.log('Добавляем трек в PeerConnection:', track.kind, track.id);
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.ontrack = (event) => {
            console.log('Получен удаленный поток:', event.streams);
            
            if (event.streams && event.streams[0]) {
                const remoteStream = event.streams[0];
                remoteVideo.srcObject = remoteStream;
                
                remoteVideo.muted = false;
                remoteVideo.volume = 1.0;
                remoteVideo.setAttribute('playsinline', 'true');
                
                remoteVideo.play().then(() => {
                    console.log('Удаленное видео запущено успешно');
                    showNotification('Соединение установлено! Звук должен работать', 'success');
                }).catch(error => {
                    console.error('Ошибка воспроизведения удаленного видео:', error);
                    remoteVideo.muted = true;
                    remoteVideo.play().then(() => {
                        console.log('Удаленное видео запущено в muted режиме');
                        showNotification('Соединение установлено. Возможно, требуется взаимодействие для включения звука', 'info');
                    });
                });
                
                const audioTracks = remoteStream.getAudioTracks();
                console.log('Аудио треки в удаленном потоке:', audioTracks);
                
                if (audioTracks.length === 0) {
                    console.warn('В удаленном потоке нет аудио треков!');
                    showNotification('Удаленный пользователь не передает звук', 'warning');
                }
            }
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Новый ICE кандидат');
                saveIceCandidate(event.candidate);
            } else {
                console.log('Все ICE кандидаты собраны');
            }
        };
        
        peerConnection.onconnectionstatechange = (event) => {
            console.log('Состояние соединения:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                console.log('PeerConnection соединен!');
                showNotification('Соединение установлено!', 'success');
            } else if (peerConnection.connectionState === 'disconnected' || 
                      peerConnection.connectionState === 'failed') {
                console.log('Соединение прервано');
                showNotification('Соединение прервано', 'error');
                endCall();
            }
        };

        peerConnection.oniceconnectionstatechange = (event) => {
            console.log('ICE состояние соединения:', peerConnection.iceConnectionState);
        };

        if (isCaller) {
            console.log('Создаем offer...');
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            console.log('Offer создан, устанавливаем local description...');
            await peerConnection.setLocalDescription(offer);
            
            await saveOffer(offer);
            listenForAnswer();
        } else {
            listenForOffer();
        }
        
        listenForIceCandidates();
        
    } catch (error) {
        console.error('Ошибка при начале звонка:', error);
        showError('Ошибка при установке соединения: ' + error.message);
        endCall();
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
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to offers');
            }
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
            
            const answer = await peerConnection.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
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
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to answers');
            }
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
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to ICE candidates');
            }
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
    loginScreen.classList.remove('active');
    waitingScreen.classList.remove('active');
    callScreen.classList.remove('active');
    
    screen.classList.add('active');
}

// Функция показа ошибки
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
    
    setTimeout(() => {
        errorMessage.classList.add('hidden');
    }, 5000);
}

// Функция показа уведомления
function showNotification(message, type = 'info') {
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

// Проверка поддержки WebRTC
function checkWebRTCAvailability() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Ваш браузер не поддерживает WebRTC или доступ к медиаустройствам');
        return false;
    }
    
    if (!window.RTCPeerConnection) {
        showError('Ваш браузер не поддерживает WebRTC');
        return false;
    }
    
    return true;
}

// Инициализация проверки WebRTC
if (!checkWebRTCAvailability()) {
    roomForm.querySelector('button').disabled = true;
}

// Периодическая очистка неактивных комнат
setInterval(async () => {
    try {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        
        const { error } = await supabase
            .from('rooms')
            .delete()
            .lt('last_activity', tenMinutesAgo);
        
        if (error) console.error('Ошибка автоматической очистки комнат:', error);
        
        await supabase
            .from('signaling')
            .delete()
            .lt('created_at', tenMinutesAgo);
            
    } catch (error) {
        console.error('Ошибка автоматической очистки комнат:', error);
    }
}, 5 * 60 * 1000);

console.log('Online Call App инициализирован');
