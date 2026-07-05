package com.readlater.app

import android.app.Application
import androidx.room.Room
import com.readlater.app.data.ApiClient
import com.readlater.app.data.AppDatabase
import com.readlater.app.data.Repository
import com.readlater.app.data.Settings

/**
 * Application class doubling as a tiny manual DI container.
 * All singletons are created lazily on first use.
 */
class ReadLaterApp : Application() {

    val database: AppDatabase by lazy {
        Room.databaseBuilder(this, AppDatabase::class.java, "readlater.db")
            .fallbackToDestructiveMigration()
            .build()
    }

    val settings: Settings by lazy { Settings(this) }

    val apiClient: ApiClient by lazy { ApiClient(settings) }

    val repository: Repository by lazy { Repository(database, apiClient) }
}
