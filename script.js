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

// Переменные состояния
let currentRoom = null;
let localStream = null;
let peerConnection = null;
let isCaller = false;
let roomTimeout = null;
let signalingChannels = [];

// Конфигурация STUN/TURN серверов
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Обработчик отправки формы
    roomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const roomNumber = roomNumberInput.value.trim();
        
        if (!roomNumber || !/^\d{1,14}$/.test(roomNumber)) {
            showError('Пожалуйста, введите корректный номер (1-14 цифр)');
            return;
        }
        
        await joinRoom(roomNumber);
    });

    // Обработчик отмены ожидания
    cancelWaitingBtn.addEventListener('click', () => {
        leaveRoom();
        showScreen(loginScreen);
    });

    // Обработчики кнопок управления звонком
    muteAudioBtn.addEventListener('click', toggleAudio);
    muteVideoBtn.addEventListener('click', toggleVideo);
    endCallBtn.addEventListener('click', endCall);

    // Обработчик ввода номера комнаты
    roomNumberInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 14);
    });
}

// Функция присоединения к комнате
async function joinRoom(roomNumber) {
    try {
        currentRoom = roomNumber;
        currentRoomSpan.textContent = roomNumber;
        
        // Проверяем существование комнаты
        const { data: existingRoom, error } = await supabase
            .from('rooms')
            .select('*')
            .eq('room_number', roomNumber)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        
        if (existingRoom) {
            // Комната существует - присоединяемся как второй участник
            if (existingRoom.participants >= 2) {
                showError('Комната уже заполнена. Максимум 2 участника.');
                return;
            }
            isCaller = false;
            await setupMedia();
            await joinExistingRoom(existingRoom);
        } else {
            // Комната не существует - создаем новую
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

// Функция создания новой комнаты
async function createNewRoom() {
    const { data, error } = await supabase
        .from('rooms')
        .insert([
            { 
                room_number: currentRoom,
                created_at: new Date().toISOString(),
                participants: 1
            }
        ])
        .select()
        .single();
    
    if (error) throw error;
    
    // Подписываемся на изменения комнаты
    subscribeToRoomChanges();
}

// Функция присоединения к существующей комнате
async function joinExistingRoom(room) {
    // Обновляем количество участников
    const { error } = await supabase
        .from('rooms')
        .update({ participants: 2 })
        .eq('room_number', currentRoom);
    
    if (error) throw error;
    
    // Подписываемся на изменения комнаты
    subscribeToRoomChanges();
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
                        // Второй участник присоединился - начинаем звонок
                        await startCall();
                    }
                } else if (payload.eventType === 'DELETE') {
                    // Комната удалена - завершаем звонок
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

// Функция настройки медиа (камера и микрофон)
async function setupMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        localVideo.srcObject = localStream;
    } catch (error) {
        console.error('Ошибка доступа к медиаустройствам:', error);
        showError('Не удалось получить доступ к камере и микрофону. Пожалуйста, разрешите доступ и обновите страницу.');
        throw error;
    }
}

// Функция начала звонка
async function startCall() {
    showScreen(callScreen);
    callRoomSpan.textContent = currentRoom;
    
    try {
        // Создаем Peer Connection
        peerConnection = new RTCPeerConnection(configuration);
        
        // Добавляем локальный поток
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        // Обработчик получения удаленного потока
        peerConnection.ontrack = (event) => {
            console.log('Получен удаленный поток');
            remoteVideo.srcObject = event.streams[0];
        };
        
        // Обработчик ICE кандидатов
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Новый ICE кандидат');
                saveIceCandidate(event.candidate);
            }
        };
        
        // Обработчик изменения состояния соединения
        peerConnection.onconnectionstatechange = (event) => {
            console.log('Состояние соединения:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                console.log('Соединение установлено!');
            } else if (peerConnection.connectionState === 'disconnected' || 
                      peerConnection.connectionState === 'failed') {
                console.log('Соединение прервано');
                showError('Соединение прервано');
                endCall();
            }
        };
        
        if (isCaller) {
            // Создаем предложение
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await peerConnection.setLocalDescription(offer);
            
            // Сохраняем предложение в Supabase
            await saveOffer(offer);
            
            // Слушаем ответ
            listenForAnswer();
        } else {
            // Слушаем предложение
            listenForOffer();
        }
        
        // Слушаем ICE кандидаты
        listenForIceCandidates();
        
    } catch (error) {
        console.error('Ошибка при начале звонка:', error);
        showError('Ошибка при установке соединения: ' + error.message);
        endCall();
    }
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
            await peerConnection.setRemoteDescription({
                type: 'offer',
                sdp: offerData.sdp
            });
            
            // Создаем ответ
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            // Сохраняем ответ в Supabase
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
                    await peerConnection.setRemoteDescription({
                        type: 'answer',
                        sdp: payload.new.sdp
                    });
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
                if (peerConnection) {
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
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            muteAudioBtn.classList.toggle('muted', !audioTrack.enabled);
        }
    }
}

// Функция переключения видео
function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            muteVideoBtn.classList.toggle('muted', !videoTrack.enabled);
        }
    }
}

// Функция завершения звонка
async function endCall() {
    console.log('Завершение звонка');
    
    // Останавливаем медиапотоки
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Закрываем Peer Connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    // Выходим из комнаты
    await leaveRoom();
    
    // Показываем экран входа
    showScreen(loginScreen);
}

// Функция выхода из комнаты
async function leaveRoom() {
    if (currentRoom) {
        try {
            // Получаем текущее состояние комнаты
            const { data: room } = await supabase
                .from('rooms')
                .select('participants')
                .eq('room_number', currentRoom)
                .single();
            
            if (room) {
                if (room.participants === 1) {
                    // Удаляем комнату, если остался один участник
                    await supabase
                        .from('rooms')
                        .delete()
                        .eq('room_number', currentRoom);
                } else {
                    // Уменьшаем количество участников
                    await supabase
                        .from('rooms')
                        .update({ participants: room.participants - 1 })
                        .eq('room_number', currentRoom);
                }
            }
            
            // Очищаем signaling данные
            await supabase
                .from('signaling')
                .delete()
                .eq('room_number', currentRoom);
                
        } catch (error) {
            console.error('Ошибка при выходе из комнаты:', error);
        }
        
        // Отписываемся от каналов
        cleanupSignalingChannels();
        
        currentRoom = null;
    }
    
    // Очищаем таймаут комнаты
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
            // Удаляем комнату по таймауту
            try {
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', currentRoom);
                
                showScreen(loginScreen);
                showError('Время ожидания истекло. Комната удалена.');
            } catch (error) {
                console.error('Ошибка удаления комнаты по таймауту:', error);
            }
        }
    }, 5 * 60 * 1000); // 5 минут
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
    
    currentRoom = null;
}

// Обработчик изменения состояния соединения
window.addEventListener('beforeunload', async () => {
    if (currentRoom) {
        await leaveRoom();
    }
});

// Обработчик изменения видимости страницы
document.addEventListener('visibilitychange', () => {
    if (document.hidden && currentRoom) {
        // Страница скрыта - можно добавить логику паузы
        console.log('Страница скрыта');
    }
});
